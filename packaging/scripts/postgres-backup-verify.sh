#!/usr/bin/env bash
set -Eeuo pipefail

umask 0077
export LC_ALL=C
export TZ=UTC

readonly production_backup_directory=/var/backups/matchplane/postgres
readonly archive_name_regex='^matchplane-postgres-[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9]{12}\.dump$'
readonly checksum_name_regex='^matchplane-postgres-[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9]{12}\.dump\.sha256$'
readonly backup_service=matchplane-postgres-backup.service
readonly backup_timer=matchplane-postgres-backup.timer

backup_directory=${MATCHPLANE_POSTGRES_BACKUP_DIRECTORY:-$production_backup_directory}
expected_backup_directory=${MATCHPLANE_POSTGRES_BACKUP_EXPECTED_DIRECTORY:-$production_backup_directory}
expected_owner_uid=${MATCHPLANE_POSTGRES_BACKUP_OWNER_UID:-}
expected_owner_gid=${MATCHPLANE_POSTGRES_BACKUP_OWNER_GID:-}
if [[ $backup_directory == "$production_backup_directory" ]]; then
  PATH=/usr/sbin:/usr/bin:/sbin:/bin
fi
start_epoch=$(date +%s 2>/dev/null || printf '0')
current_file=
current_bytes=0
validated_size=0
validated_mtime=0
lock_fd=

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
  local elapsed
  elapsed=$(elapsed_seconds)
  if [[ -n $current_file ]]; then
    printf 'matchplane_postgres_backup_verify status=failed stage=%s file=%s bytes=%s elapsed_seconds=%s\n' \
      "$stage" "$current_file" "$current_bytes" "$elapsed" >&2
  else
    printf 'matchplane_postgres_backup_verify status=failed stage=%s bytes=0 elapsed_seconds=%s\n' \
      "$stage" "$elapsed" >&2
  fi
  exit 1
}

require_commands() {
  local command_name
  for command_name in date flock id pg_restore realpath sha256sum stat systemctl; do
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

  if [[ -z $expected_owner_uid ]]; then
    expected_owner_uid=$(id -u postgres 2>/dev/null) || fail unsafe_directory
  fi
  if [[ -z $expected_owner_gid ]]; then
    expected_owner_gid=$(id -g postgres 2>/dev/null) || fail unsafe_directory
  fi
  [[ $expected_owner_uid =~ ^[0-9]+$ && $expected_owner_gid =~ ^[0-9]+$ ]] ||
    fail unsafe_directory

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

require_commands
validate_backup_directory
if ! { exec {lock_fd}<"$backup_directory"; } 2>/dev/null; then
  fail lock_open
fi
if ! flock --shared --wait 30 "$lock_fd" >/dev/null 2>&1; then
  fail backup_busy
fi
locked_identity=$(stat -Lc '%d:%i' -- "/proc/self/fd/$lock_fd" 2>/dev/null) || fail unsafe_directory
[[ $locked_identity == "$directory_identity" ]] || fail unsafe_directory

latest_archive=
latest_mtime=0
shopt -s nullglob
for path in "$backup_directory"/matchplane-postgres-*; do
  name=${path##*/}
  if [[ $name =~ $archive_name_regex || $name =~ $checksum_name_regex ]]; then
    validate_managed_file "$path"
    if [[ $name =~ $archive_name_regex ]]; then
      if [[ $validated_mtime -gt $latest_mtime ]] ||
        { [[ $validated_mtime -eq $latest_mtime ]] && [[ $path > $latest_archive ]]; }; then
        latest_archive=$path
        latest_mtime=$validated_mtime
      fi
    fi
  fi
done
shopt -u nullglob
[[ -n $latest_archive ]] || fail archive_missing

validate_managed_file "$latest_archive"
archive_basename=${latest_archive##*/}
current_file=$archive_basename
current_bytes=$validated_size
checksum_path="${latest_archive}.sha256"
[[ -e $checksum_path && ! -L $checksum_path ]] || fail checksum_missing
validate_managed_file "$checksum_path"
checksum_size=$validated_size
expected_checksum_size=$((64 + 2 + ${#archive_basename} + 1))
[[ $checksum_size -eq $expected_checksum_size ]] || fail checksum_format
IFS= read -r checksum_line <"$checksum_path" 2>/dev/null || fail checksum_format
checksum=${checksum_line%%  *}
checksum_file=${checksum_line#*  }
[[ $checksum =~ ^[0-9a-f]{64}$ && $checksum_file == "$archive_basename" ]] || fail checksum_format

current_file=$archive_basename
current_bytes=$(stat -Lc '%s' -- "$latest_archive" 2>/dev/null) || fail archive_stat
actual_checksum_output=$(sha256sum -- "$latest_archive" 2>/dev/null) || fail checksum
actual_checksum=${actual_checksum_output%% *}
[[ $actual_checksum == "$checksum" ]] || fail checksum

if ! env -i HOME=/nonexistent LC_ALL=C PATH="$PATH" TZ=UTC \
  pg_restore --list "$latest_archive" >/dev/null 2>&1; then
  fail archive_verify
fi

systemctl is-enabled --quiet "$backup_timer" >/dev/null 2>&1 || fail timer_disabled
systemctl is-active --quiet "$backup_timer" >/dev/null 2>&1 || fail timer_inactive
service_result=$(systemctl show "$backup_service" --property=Result --value 2>/dev/null) ||
  fail service_status
service_code=$(systemctl show "$backup_service" --property=ExecMainCode --value 2>/dev/null) ||
  fail service_status
service_status=$(systemctl show "$backup_service" --property=ExecMainStatus --value 2>/dev/null) ||
  fail service_status
service_started=$(systemctl show "$backup_service" --property=ExecMainStartTimestampMonotonic --value 2>/dev/null) ||
  fail service_status
[[ $service_result == success && $service_code == 1 && $service_status == 0 ]] ||
  fail last_backup_failed
[[ $service_started =~ ^[0-9]+$ && $service_started -gt 0 ]] || fail backup_never_ran

printf 'matchplane_postgres_backup_verify status=ok file=%s bytes=%s elapsed_seconds=%s\n' \
  "$archive_basename" "$current_bytes" "$(elapsed_seconds)"
