#!/usr/bin/env bash
set -Eeuo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
backup_script="$repository_root/packaging/scripts/postgres-backup.sh"
verify_script="$repository_root/packaging/scripts/postgres-backup-verify.sh"
original_path=$PATH
work_directory=$(mktemp -d)
trap 'rm -rf "$work_directory"' EXIT

case_root=
backup_directory=
fake_bin=
tests_run=0

fail_test() {
  printf 'postgres backup gate test failed: %s\n' "$1" >&2
  exit 1
}

assert_no_fragments() {
  local fragment
  fragment=$(find "$backup_directory" -maxdepth 1 -type f -name '*.part' -print -quit)
  [[ -z $fragment ]] || fail_test "temporary fragment remains: ${fragment##*/}"
}

assert_no_archives() {
  local archives
  archives=$(find "$backup_directory" -maxdepth 1 -type f \
    \( -name 'matchplane-postgres-*.dump' -o -name 'matchplane-postgres-*.dump.sha256' \) \
    -print -quit)
  [[ -z $archives ]] || fail_test 'a failed backup published an archive'
}

write_fake_tools() {
  cat >"$fake_bin/pg_dump" <<'FAKE_PG_DUMP'
#!/usr/bin/env bash
set -euo pipefail
tool_directory=$(cd "$(dirname "$0")" && pwd)
mode=$(<"$tool_directory/pg_dump.mode")
{
  printf 'CALL\n'
  printf '<%s>\n' "$@"
} >>"$tool_directory/pg_dump.log"
[[ ${PGHOST:-} == /run/postgresql ]]
[[ ${PGUSER:-} == postgres ]]
[[ ${PGDATABASE:-} == matchplane ]]
[[ ${PGPASSFILE:-} == /dev/null ]]
[[ -z ${PGPASSWORD+x} ]]
[[ ${HOME:-} == /nonexistent ]]
output=
for argument in "$@"; do
  case "$argument" in
    --file=*) output=${argument#--file=} ;;
  esac
done
[[ -n $output ]] || exit 92
case "$mode" in
  fail)
    exit 41
    ;;
  block)
    : >"$tool_directory/dump.started"
    while [[ ! -e $tool_directory/dump.release ]]; do
      sleep 0.01
    done
    ;;
  success) ;;
  *) exit 93 ;;
esac
printf 'FAKE_CUSTOM_POSTGRES_ARCHIVE\n' >"$output"
FAKE_PG_DUMP

  cat >"$fake_bin/pg_restore" <<'FAKE_PG_RESTORE'
#!/usr/bin/env bash
set -euo pipefail
tool_directory=$(cd "$(dirname "$0")" && pwd)
mode=$(<"$tool_directory/pg_restore.mode")
{
  printf 'CALL\n'
  printf '<%s>\n' "$@"
} >>"$tool_directory/pg_restore.log"
[[ $mode == success ]] || exit 42
[[ -z ${PGPASSWORD+x} && -z ${PGHOST+x} && ${HOME:-} == /nonexistent ]]
archive=${*: -1}
grep -q '^FAKE_CUSTOM_POSTGRES_ARCHIVE$' "$archive" || exit 43
printf 'FAKE TOC OUTPUT THAT MUST NOT REACH THE JOURNAL\n'
FAKE_PG_RESTORE

  cat >"$fake_bin/systemctl" <<'FAKE_SYSTEMCTL'
#!/usr/bin/env bash
set -euo pipefail
tool_directory=$(cd "$(dirname "$0")" && pwd)
mode=$(<"$tool_directory/systemctl.mode")
command_name=${1:-}
case "$command_name" in
  is-enabled)
    [[ $mode != timer-disabled ]]
    ;;
  is-active)
    [[ $mode != timer-inactive ]]
    ;;
  show)
    property=
    for argument in "$@"; do
      case "$argument" in
        --property=*) property=${argument#--property=} ;;
      esac
    done
    case "$property" in
      Result)
        if [[ $mode == service-failed ]]; then printf 'exit-code\n'; else printf 'success\n'; fi
        ;;
      ExecMainCode) printf '1\n' ;;
      ExecMainStatus)
        if [[ $mode == service-failed ]]; then printf '1\n'; else printf '0\n'; fi
        ;;
      ExecMainStartTimestampMonotonic)
        if [[ $mode == never-ran ]]; then printf '0\n'; else printf '123456\n'; fi
        ;;
      *) exit 44 ;;
    esac
    ;;
  *) exit 45 ;;
esac
FAKE_SYSTEMCTL

  chmod 0755 "$fake_bin/pg_dump" "$fake_bin/pg_restore" "$fake_bin/systemctl"
  printf 'success\n' >"$fake_bin/pg_dump.mode"
  printf 'success\n' >"$fake_bin/pg_restore.mode"
  printf 'success\n' >"$fake_bin/systemctl.mode"
  : >"$fake_bin/pg_dump.log"
  : >"$fake_bin/pg_restore.log"
}

new_case() {
  case_root=$(mktemp -d "$work_directory/case.XXXXXXXX")
  backup_directory="$case_root/backups"
  fake_bin="$case_root/fake-bin"
  mkdir -m 0700 "$backup_directory"
  mkdir -m 0755 "$fake_bin"
  write_fake_tools
}

run_backup() {
  env \
    MATCHPLANE_POSTGRES_BACKUP_DIRECTORY="$backup_directory" \
    MATCHPLANE_POSTGRES_BACKUP_EXPECTED_DIRECTORY="$backup_directory" \
    MATCHPLANE_POSTGRES_BACKUP_OWNER_UID="$(id -u)" \
    MATCHPLANE_POSTGRES_BACKUP_OWNER_GID="$(id -g)" \
    MATCHPLANE_POSTGRES_BACKUP_RETENTION_DAYS="${RETENTION_DAYS:-14}" \
    PATH="$fake_bin:$original_path" \
    "$backup_script"
}

run_verify() {
  env \
    MATCHPLANE_POSTGRES_BACKUP_DIRECTORY="$backup_directory" \
    MATCHPLANE_POSTGRES_BACKUP_EXPECTED_DIRECTORY="$backup_directory" \
    MATCHPLANE_POSTGRES_BACKUP_OWNER_UID="$(id -u)" \
    MATCHPLANE_POSTGRES_BACKUP_OWNER_GID="$(id -g)" \
    PATH="$fake_bin:$original_path" \
    "$verify_script"
}

record_pass() {
  tests_run=$((tests_run + 1))
  printf 'ok %d - %s\n' "$tests_run" "$1"
}

test_success() {
  local output verify_output archive sidecar mode
  local -a archives
  new_case
  output=$(run_backup 2>&1) || fail_test 'successful fake dump failed'
  [[ $output != *"$case_root"* ]] || fail_test 'backup log exposed an absolute path'
  [[ $output != *'FAKE TOC OUTPUT'* ]] || fail_test 'pg_restore output reached the backup log'
  shopt -s nullglob
  archives=("$backup_directory"/matchplane-postgres-*.dump)
  shopt -u nullglob
  [[ ${#archives[@]} -eq 1 ]] || fail_test 'success did not publish exactly one archive'
  archive=${archives[0]}
  sidecar="${archive}.sha256"
  [[ -f $sidecar ]] || fail_test 'success did not publish a checksum sidecar'
  mode=$(stat -Lc '%a:%h' "$archive")
  [[ $mode == 600:1 ]] || fail_test 'archive mode or link count is unsafe'
  mode=$(stat -Lc '%a:%h' "$sidecar")
  [[ $mode == 600:1 ]] || fail_test 'sidecar mode or link count is unsafe'
  (cd "$backup_directory" && sha256sum --check --status "${sidecar##*/}") ||
    fail_test 'published checksum does not match'
  grep -Fxq '<--no-password>' "$fake_bin/pg_dump.log" || fail_test 'pg_dump omitted --no-password'
  grep -Fxq '<--host=/run/postgresql>' "$fake_bin/pg_dump.log" || fail_test 'pg_dump did not use the local socket'
  grep -Fxq '<--username=postgres>' "$fake_bin/pg_dump.log" || fail_test 'pg_dump did not fix the peer role'
  grep -Fxq '<--dbname=matchplane>' "$fake_bin/pg_dump.log" || fail_test 'pg_dump did not fix the database name'
  grep -Fxq '<--format=custom>' "$fake_bin/pg_dump.log" || fail_test 'pg_dump did not use custom format'
  if grep -Eqi 'postgres(ql)?://|password=' "$fake_bin/pg_dump.log"; then
    fail_test 'pg_dump received a URL or password'
  fi
  verify_output=$(run_verify 2>&1) || fail_test 'read-only verifier rejected a valid archive'
  [[ $verify_output != *"$case_root"* ]] || fail_test 'verify log exposed an absolute path'
  [[ $verify_output != *'FAKE TOC OUTPUT'* ]] || fail_test 'pg_restore output reached the verify log'
  assert_no_fragments
  record_pass 'success publishes and verifies an atomic archive'
}

test_dump_failure() {
  local output
  new_case
  printf 'fail\n' >"$fake_bin/pg_dump.mode"
  if output=$(run_backup 2>&1); then
    fail_test 'pg_dump failure returned success'
  fi
  [[ $output != *"$case_root"* ]] || fail_test 'dump failure log exposed an absolute path'
  assert_no_archives
  assert_no_fragments
  record_pass 'pg_dump failure publishes nothing'
}

test_archive_verification_failure() {
  local output
  new_case
  printf 'fail\n' >"$fake_bin/pg_restore.mode"
  if output=$(run_backup 2>&1); then
    fail_test 'pg_restore --list failure returned success'
  fi
  [[ $output != *"$case_root"* ]] || fail_test 'archive verification log exposed an absolute path'
  assert_no_archives
  assert_no_fragments
  record_pass 'pg_restore verification failure publishes nothing'
}

test_read_only_verify_failure() {
  local archive before after
  local -a archives
  new_case
  run_backup >/dev/null 2>&1 || fail_test 'fixture backup failed'
  shopt -s nullglob
  archives=("$backup_directory"/matchplane-postgres-*.dump)
  shopt -u nullglob
  archive=${archives[0]}
  printf 'tamper\n' >>"$archive"
  before=$(sha256sum "$archive")
  if run_verify >/dev/null 2>&1; then
    fail_test 'verifier accepted a checksum mismatch'
  fi
  after=$(sha256sum "$archive")
  [[ $before == "$after" ]] || fail_test 'verifier modified the archive'
  assert_no_fragments
  record_pass 'read-only verifier fails closed on checksum mismatch'
}

test_systemd_gate_failures() {
  local archive before after
  local -a archives
  new_case
  run_backup >/dev/null 2>&1 || fail_test 'systemd gate fixture backup failed'
  shopt -s nullglob
  archives=("$backup_directory"/matchplane-postgres-*.dump)
  shopt -u nullglob
  archive=${archives[0]}
  before=$(sha256sum "$archive")

  printf 'timer-disabled\n' >"$fake_bin/systemctl.mode"
  if run_verify >/dev/null 2>&1; then
    fail_test 'verifier accepted a disabled timer'
  fi
  printf 'service-failed\n' >"$fake_bin/systemctl.mode"
  if run_verify >/dev/null 2>&1; then
    fail_test 'verifier accepted a failed last backup result'
  fi

  after=$(sha256sum "$archive")
  [[ $before == "$after" ]] || fail_test 'systemd gate verification modified the archive'
  assert_no_fragments
  record_pass 'verifier requires an enabled timer and successful last result'
}

test_concurrency() {
  local first_pid second_status invocation_count
  new_case
  printf 'block\n' >"$fake_bin/pg_dump.mode"
  run_backup >"$case_root/first.out" 2>&1 &
  first_pid=$!
  for _ in $(seq 1 500); do
    [[ -e $fake_bin/dump.started ]] && break
    sleep 0.01
  done
  if [[ ! -e $fake_bin/dump.started ]]; then
    kill "$first_pid" 2>/dev/null || true
    wait "$first_pid" 2>/dev/null || true
    fail_test 'blocking dump did not start'
  fi
  if run_backup >"$case_root/second.out" 2>&1; then
    touch "$fake_bin/dump.release"
    wait "$first_pid" 2>/dev/null || true
    fail_test 'concurrent backup acquired the lock'
  else
    second_status=$?
  fi
  [[ $second_status -eq 75 ]] || fail_test 'concurrent backup did not return EX_TEMPFAIL'
  touch "$fake_bin/dump.release"
  wait "$first_pid" || fail_test 'first backup failed after concurrency test release'
  invocation_count=$(grep -c '^CALL$' "$fake_bin/pg_dump.log")
  [[ $invocation_count -eq 1 ]] || fail_test 'concurrent attempt invoked pg_dump'
  assert_no_fragments
  record_pass 'flock rejects concurrent dumps'
}

test_symlinks_and_hardlinks() {
  local target linked_path hardlink_source
  new_case
  target="$case_root/real-backups"
  mv "$backup_directory" "$target"
  ln -s "$target" "$backup_directory"
  if run_backup >/dev/null 2>&1; then
    fail_test 'backup accepted a symlink directory'
  fi
  [[ -z $(find "$target" -maxdepth 1 -type f -print -quit) ]] ||
    fail_test 'symlink directory rejection created a file'

  new_case
  linked_path="$backup_directory/matchplane-postgres-20000101T000000Z-Symlink12345.dump"
  ln -s /dev/null "$linked_path"
  if run_backup >/dev/null 2>&1; then
    fail_test 'backup accepted a managed symlink'
  fi
  [[ ! -s $fake_bin/pg_dump.log ]] || fail_test 'symlink preflight invoked pg_dump'
  rm "$linked_path"

  hardlink_source="$backup_directory/hardlink-source"
  printf 'unsafe\n' >"$hardlink_source"
  chmod 0600 "$hardlink_source"
  linked_path="$backup_directory/matchplane-postgres-20000101T000000Z-Hardlink1234.dump"
  ln "$hardlink_source" "$linked_path"
  if run_backup >/dev/null 2>&1; then
    fail_test 'backup accepted a managed hardlink'
  fi
  [[ ! -s $fake_bin/pg_dump.log ]] || fail_test 'hardlink preflight invoked pg_dump'
  assert_no_fragments
  record_pass 'symlink and hardlink inputs fail closed'
}

test_retention() {
  local source_archive old_archive old_sidecar unexpected
  local -a archives
  new_case
  run_backup >/dev/null 2>&1 || fail_test 'retention fixture backup failed'
  shopt -s nullglob
  archives=("$backup_directory"/matchplane-postgres-*.dump)
  shopt -u nullglob
  source_archive=${archives[0]}
  old_archive="$backup_directory/matchplane-postgres-20000101T000000Z-OldToken1234.dump"
  old_sidecar="${old_archive}.sha256"
  cp "$source_archive" "$old_archive"
  checksum=$(sha256sum "$old_archive")
  checksum=${checksum%% *}
  printf '%s  %s\n' "$checksum" "${old_archive##*/}" >"$old_sidecar"
  chmod 0600 "$old_archive" "$old_sidecar"
  touch -d '15 days ago' "$old_archive" "$old_sidecar"
  unexpected="$backup_directory/matchplane-postgres-do-not-delete.dump"
  printf 'operator-owned unexpected file\n' >"$unexpected"
  chmod 0600 "$unexpected"
  touch -d '30 days ago' "$unexpected"

  RETENTION_DAYS=14 run_backup >/dev/null 2>&1 || fail_test 'retention backup failed'
  [[ ! -e $old_archive && ! -e $old_sidecar ]] || fail_test 'expired strict archive pair was retained'
  [[ -f $unexpected ]] || fail_test 'retention deleted a non-matching file'
  assert_no_fragments
  record_pass 'retention removes only expired strict names'
}

test_success
test_dump_failure
test_archive_verification_failure
test_read_only_verify_failure
test_systemd_gate_failures
test_concurrency
test_symlinks_and_hardlinks
test_retention

printf 'postgres backup gate: %d deterministic fake-tool tests passed\n' "$tests_run"
