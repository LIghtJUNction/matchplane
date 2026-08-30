#!/usr/bin/env bash
set -euo pipefail

if ((EUID != 0)); then
  if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true >/dev/null 2>&1; then
    echo 'conversion recovery permission test requires root or passwordless sudo' >&2
    exit 1
  fi
  exec sudo -n -- "$0" "$@"
fi

for command in systemd-sysusers setpriv awk install stat; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "conversion recovery permission test requires $command" >&2
    exit 1
  }
done

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT
chmod 0755 "$test_root"
install -d -m 0755 "$test_root/etc/matchplane"
systemd-sysusers --root="$test_root" "$repository_root/packaging/sysusers/matchplane.conf" \
  >/dev/null 2>&1

projector_uid=$(awk -F: '$1 == "matchplane-conversion" { print $3 }' "$test_root/etc/passwd")
projector_gid=$(awk -F: '$1 == "matchplane-conversion" { print $3 }' "$test_root/etc/group")
[[ -n $projector_uid && -n $projector_gid ]]

recovery_dir="$test_root/etc/matchplane/recovery"
recovery_file="$recovery_dir/conversion-projections.env"
install -d -o root -g root -m 0750 "$recovery_dir"
printf '%s\n' \
  'MATCHPLANE_RECOVERY_DATABASE_URL=postgres://recovery:secret@localhost/matchplane' \
  >"$recovery_file"
chown root:root "$recovery_file"
chmod 0640 "$recovery_file"

[[ $(stat -c '%u:%g %a' "$recovery_file") == '0:0 640' ]]
test -r "$recovery_file"
if setpriv --reuid "$projector_uid" --regid "$projector_gid" --clear-groups \
  -- /usr/bin/test -r "$recovery_file"; then
  echo 'matchplane-conversion unexpectedly traversed the root recovery directory' >&2
  exit 1
fi
chmod 0755 "$recovery_dir"
if setpriv --reuid "$projector_uid" --regid "$projector_gid" --clear-groups \
  -- /usr/bin/test -r "$recovery_file"; then
  echo 'matchplane-conversion unexpectedly read the root:root 0640 recovery credential' >&2
  exit 1
fi
chmod 0750 "$recovery_dir"
