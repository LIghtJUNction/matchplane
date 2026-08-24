#!/usr/bin/env bash
set -Eeuo pipefail

umask 0077
export LC_ALL=C
export TZ=UTC

readonly production_backup_directory=/var/backups/matchplane/postgres
readonly postgres_socket_directory=/run/postgresql
readonly postgres_database=matchplane
readonly postgres_user=postgres
readonly archive_name_regex='^matchplane-postgres-[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9]{12}\.dump$'
readonly checksum_name_regex='^matchplane-postgres-[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9]{12}\.dump\.sha256$'

backup_directory=${MATCHPLANE_POSTGRES_BACKUP_DIRECTORY:-$production_backup_directory}
expected_backup_directory=${MATCHPLANE_POSTGRES_BACKUP_EXPECTED_DIRECTORY:-$production_backup_directory}
retention_days=${MATCHPLANE_POSTGRES_BACKUP_RETENTION_DAYS:-14}
expected_owner_uid=${MATCHPLANE_POSTGRES_BACKUP_OWNER_UID:-$EUID}
expected_owner_gid=${MATCHPLANE_POSTGRES_BACKUP_OWNER_GID:-}
if [[ $backup_directory == "$production_backup_directory" ]]; then
  PATH=/usr/bin:/bin
fi

start_epoch=$(date +%s 2>/dev/null || printf '0')
current_file=
current_bytes=0
temporary_archive=
temporary_checksum=
published_archive=
published_checksum=
committed=0
lock_fd=
validated_size=0
validated_mtime=0

elapsed_seconds() {
  local now
  now=$(date +%s 2>/dev/null || printf '%s' "$start_epoch")
  if [[ $now =~ ^[0-9]+$ && $start_epoch =~ ^[0-9]+$ && $now -ge $start_epoch ]]; then
    printf '%s' "$((now - start_epoch))"
  else
    printf '0'
  fi
}

fail() {
  local stage=$1
  local status=${2:-1}
  local elapsed
  elapsed=$(elapsed_seconds)
  if [[ -n $current_file ]]; then
    printf 'matchplane_postgres_backup status=failed stage=%s file=%s bytes=%s elapsed_seconds=%s\n' \
      "$stage" "$current_file" "$current_bytes" "$elapsed" >&2
  else
    printf 'matchplane_postgres_backup status=failed stage=%s bytes=0 elapsed_seconds=%s\n' \
      "$stage" "$elapsed" >&2
  fi
  exit "$status"
}

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n $temporary_archive ]]; then
    rm -f -- "$temporary_archive" >/dev/null 2>&1 || true
  fi
  if [[ -n $temporary_checksum ]]; then
    rm -f -- "$temporary_checksum" >/dev/null 2>&1 || true
  fi
  if [[ $committed -ne 1 ]]; then
    if [[ -n $published_archive ]]; then
      rm -f -- "$published_archive" >/dev/null 2>&1 || true
    fi
    if [[ -n $published_checksum ]]; then
      rm -f -- "$published_checksum" >/dev/null 2>&1 || true
    fi
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'fail interrupted 129' HUP
trap 'fail interrupted 130' INT
trap 'fail interrupted 143' TERM

require_commands() {
  local command_name
  for command_name in date env flock id mktemp mv pg_dump pg_restore realpath rm sha256sum stat sync; do
    command -v "$command_name" >/dev/null 2>&1 || fail missing_dependency
  done
}

validate_backup_directory() {
  local canonical metadata owner_uid owner_gid mode device inode

  [[ $backup_directory == "$expected_backup_directory" ]] || fail unexpected_directory
  [[ $backup_directory == /* && $backup_directory != *$'\n'* ]] || fail unexpected_directory
  [[ -d $backup_directory && ! -L $backup_directory ]] || fail unsafe_directory
  canonical=$(realpath -e -- "$backup_directory" 2>/dev/null) || fail unsafe_directory
  [[ $canonical == "$backup_directory" ]] || fail unsafe_directory

  if [[ -z $expected_owner_gid ]]; then
    expected_owner_gid=$(id -g 2>/dev/null) || fail unsafe_directory
  fi
  [[ $expected_owner_uid =~ ^[0-9]+$ && $expected_owner_gid =~ ^[0-9]+$ ]] ||
    fail unsafe_directory
  [[ $EUID -eq $expected_owner_uid ]] || fail unsafe_directory

  metadata=$(stat -Lc '%u:%g:%a:%d:%i' -- "$backup_directory" 2>/dev/null) ||
    fail unsafe_directory
  IFS=: read -r owner_uid owner_gid mode device inode <<<"$metadata"
  [[ $owner_uid == "$expected_owner_uid" && $owner_gid == "$expected_owner_gid" && $mode == 700 ]] ||
    fail unsafe_directory
  directory_identity="$device:$inode"
}

validate_managed_file() {
  local path=$1
  local name canonical metadata owner_uid owner_gid mode links size mtime

  name=${path##*/}
  current_file=$name
  current_bytes=0
  [[ $name =~ $archive_name_regex || $name =~ $checksum_name_regex ]] || fail unsafe_file
  [[ -f $path && ! -L $path ]] || fail unsafe_file
  canonical=$(realpath -e -- "$path" 2>/dev/null) || fail unsafe_file
  [[ $canonical == "$path" ]] || fail unsafe_file
  metadata=$(stat -Lc '%u:%g:%a:%h:%s:%Y' -- "$path" 2>/dev/null) || fail unsafe_file
  IFS=: read -r owner_uid owner_gid mode links size mtime <<<"$metadata"
  current_bytes=$size
  [[ $owner_uid == "$expected_owner_uid" && $owner_gid == "$expected_owner_gid" ]] ||
    fail unsafe_file
  [[ $mode == 600 && $links == 1 && $size =~ ^[0-9]+$ && $size -gt 0 && $mtime =~ ^[0-9]+$ ]] ||
    fail unsafe_file
  validated_size=$size
  validated_mtime=$mtime
}

validate_private_temporary_file() {
  local path=$1
  local metadata owner_uid owner_gid mode links

  [[ -f $path && ! -L $path ]] || fail unsafe_temporary_file
  metadata=$(stat -Lc '%u:%g:%a:%h' -- "$path" 2>/dev/null) || fail unsafe_temporary_file
  IFS=: read -r owner_uid owner_gid mode links <<<"$metadata"
  [[ $owner_uid == "$expected_owner_uid" && $owner_gid == "$expected_owner_gid" ]] ||
    fail unsafe_temporary_file
  [[ $mode == 600 && $links == 1 ]] || fail unsafe_temporary_file
}

preflight_managed_files() {
  local path name

  shopt -s nullglob
  for path in "$backup_directory"/matchplane-postgres-*; do
    name=${path##*/}
    if [[ $name =~ $archive_name_regex || $name =~ $checksum_name_regex ]]; then
      validate_managed_file "$path"
    fi
  done
  shopt -u nullglob
  current_file=
  current_bytes=0
}

remove_retained_backups() {
  local now cutoff path name archive sidecar size
  local removed=0
  declare -a archives_to_remove=()
  declare -a sidecars_to_remove=()
  declare -A queued_sidecars=()

  now=$(date +%s 2>/dev/null) || fail retention_clock
  [[ $now =~ ^[0-9]+$ ]] || fail retention_clock
  cutoff=$((now - retention_days * 86400))

  # Validate the complete managed set before deleting anything. Files outside the
  # exact archive/sidecar grammar are deliberately ignored and never retained away.
  preflight_managed_files

  shopt -s nullglob
  for path in "$backup_directory"/matchplane-postgres-*.dump; do
    name=${path##*/}
    [[ $name =~ $archive_name_regex ]] || continue
    [[ $path != "$published_archive" ]] || continue
    validate_managed_file "$path"
    if [[ $validated_mtime -lt $cutoff ]]; then
      archives_to_remove+=("$path")
      sidecar="${path}.sha256"
      if [[ -e $sidecar || -L $sidecar ]]; then
        sidecars_to_remove+=("$sidecar")
        queued_sidecars["$sidecar"]=1
      fi
    fi
  done

  for path in "$backup_directory"/matchplane-postgres-*.dump.sha256; do
    name=${path##*/}
    [[ $name =~ $checksum_name_regex ]] || continue
    [[ -z ${queued_sidecars["$path"]+present} ]] || continue
    archive=${path%.sha256}
    if [[ ! -e $archive && ! -L $archive ]]; then
      validate_managed_file "$path"
      if [[ $validated_mtime -lt $cutoff ]]; then
        sidecars_to_remove+=("$path")
      fi
    fi
  done
  shopt -u nullglob

  for path in "${archives_to_remove[@]}"; do
    validate_managed_file "$path"
    size=$validated_size
    rm -f -- "$path" >/dev/null 2>&1 || fail retention_remove
    removed=1
    printf 'matchplane_postgres_backup status=retained_removed file=%s bytes=%s elapsed_seconds=%s\n' \
      "${path##*/}" "$size" "$(elapsed_seconds)"
  done
  for path in "${sidecars_to_remove[@]}"; do
    [[ -e $path || -L $path ]] || continue
    validate_managed_file "$path"
    size=$validated_size
    rm -f -- "$path" >/dev/null 2>&1 || fail retention_remove
    removed=1
    printf 'matchplane_postgres_backup status=retained_removed file=%s bytes=%s elapsed_seconds=%s\n' \
      "${path##*/}" "$size" "$(elapsed_seconds)"
  done
  if [[ $removed -eq 1 ]]; then
    sync "$backup_directory" >/dev/null 2>&1 || fail retention_fsync
  fi
  current_file=
  current_bytes=0
}

require_commands
[[ $retention_days =~ ^[0-9]+$ && $retention_days -ge 1 && $retention_days -le 3650 ]] ||
  fail invalid_retention
validate_backup_directory

if ! { exec {lock_fd}<"$backup_directory"; } 2>/dev/null; then
  fail lock_open
fi
if ! flock --exclusive --nonblock "$lock_fd" >/dev/null 2>&1; then
  fail concurrent_backup 75
fi
locked_identity=$(stat -Lc '%d:%i' -- "/proc/self/fd/$lock_fd" 2>/dev/null) || fail unsafe_directory
[[ $locked_identity == "$directory_identity" ]] || fail unsafe_directory

preflight_managed_files

timestamp=$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null) || fail backup_clock
[[ $timestamp =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail backup_clock
if ! temporary_archive=$(mktemp -- \
  "$backup_directory/.matchplane-postgres-${timestamp}.XXXXXXXXXXXX.dump.part" 2>/dev/null); then
  fail temporary_archive
fi
temporary_name=${temporary_archive##*/}
token=${temporary_name#".matchplane-postgres-${timestamp}."}
token=${token%.dump.part}
[[ $token =~ ^[A-Za-z0-9]{12}$ ]] || fail temporary_archive
archive_basename="matchplane-postgres-${timestamp}-${token}.dump"
[[ $archive_basename =~ $archive_name_regex ]] || fail temporary_archive
archive_path="$backup_directory/$archive_basename"
checksum_path="${archive_path}.sha256"
current_file=$archive_basename
[[ ! -e $archive_path && ! -L $archive_path && ! -e $checksum_path && ! -L $checksum_path ]] ||
  fail archive_collision
validate_private_temporary_file "$temporary_archive"

if ! temporary_checksum=$(mktemp -- \
  "$backup_directory/.${archive_basename}.XXXXXXXXXXXX.sha256.part" 2>/dev/null); then
  fail temporary_checksum
fi
validate_private_temporary_file "$temporary_checksum"

if ! env -i \
  HOME=/nonexistent \
  LC_ALL=C \
  PATH="$PATH" \
  PGAPPNAME=matchplane-postgres-backup \
  PGCONNECT_TIMEOUT=10 \
  PGDATABASE="$postgres_database" \
  PGHOST="$postgres_socket_directory" \
  PGPASSFILE=/dev/null \
  PGUSER="$postgres_user" \
  TZ=UTC \
  pg_dump \
  --no-password \
  --host="$postgres_socket_directory" \
  --username="$postgres_user" \
  --dbname="$postgres_database" \
  --format=custom \
  --file="$temporary_archive" >/dev/null 2>&1; then
  fail dump
fi
validate_private_temporary_file "$temporary_archive"
current_bytes=$(stat -Lc '%s' -- "$temporary_archive" 2>/dev/null) || fail archive_stat
[[ $current_bytes =~ ^[0-9]+$ && $current_bytes -gt 0 ]] || fail archive_stat

if ! env -i HOME=/nonexistent LC_ALL=C PATH="$PATH" TZ=UTC \
  pg_restore --list "$temporary_archive" >/dev/null 2>&1; then
  fail archive_verify
fi

checksum_output=$(sha256sum -- "$temporary_archive" 2>/dev/null) || fail checksum
checksum=${checksum_output%% *}
[[ $checksum =~ ^[0-9a-f]{64}$ ]] || fail checksum
if ! { printf '%s  %s\n' "$checksum" "$archive_basename" >"$temporary_checksum"; } 2>/dev/null; then
  fail checksum
fi
validate_private_temporary_file "$temporary_checksum"
sync "$temporary_archive" "$temporary_checksum" >/dev/null 2>&1 || fail archive_fsync

mv --no-clobber --no-target-directory -- "$temporary_checksum" "$checksum_path" >/dev/null 2>&1 ||
  fail checksum_publish
[[ ! -e $temporary_checksum && ! -L $temporary_checksum ]] || fail checksum_publish
temporary_checksum=
published_checksum=$checksum_path
validate_managed_file "$published_checksum"
current_file=$archive_basename
current_bytes=$(stat -Lc '%s' -- "$temporary_archive" 2>/dev/null) || fail archive_stat
sync "$backup_directory" >/dev/null 2>&1 || fail directory_fsync

mv --no-clobber --no-target-directory -- "$temporary_archive" "$archive_path" >/dev/null 2>&1 ||
  fail archive_publish
[[ ! -e $temporary_archive && ! -L $temporary_archive ]] || fail archive_publish
temporary_archive=
published_archive=$archive_path
validate_managed_file "$published_archive"
current_file=$archive_basename
current_bytes=$validated_size
sync "$backup_directory" >/dev/null 2>&1 || fail directory_fsync

published_checksum_output=$(sha256sum -- "$published_archive" 2>/dev/null) || fail checksum
published_checksum_value=${published_checksum_output%% *}
[[ $published_checksum_value == "$checksum" ]] || fail checksum
committed=1

remove_retained_backups
current_file=$archive_basename
current_bytes=$(stat -Lc '%s' -- "$published_archive" 2>/dev/null) || fail archive_stat
printf 'matchplane_postgres_backup status=ok file=%s bytes=%s elapsed_seconds=%s\n' \
  "$archive_basename" "$current_bytes" "$(elapsed_seconds)"
