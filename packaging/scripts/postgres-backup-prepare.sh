#!/usr/bin/env bash
set -Eeuo pipefail

PATH=/usr/sbin:/usr/bin:/sbin:/bin
readonly backups_root=/var/backups
readonly backup_parent=/var/backups/matchplane
readonly backup_directory=/var/backups/matchplane/postgres
allow_missing_postgres=0

if [[ $# -gt 1 ]]; then
  printf 'usage: %s [--if-postgres-present]\n' "${0##*/}" >&2
  exit 2
fi
if [[ $# -eq 1 ]]; then
  if [[ $1 != --if-postgres-present ]]; then
    printf 'usage: %s [--if-postgres-present]\n' "${0##*/}" >&2
    exit 2
  fi
  allow_missing_postgres=1
fi
if [[ $EUID -ne 0 ]]; then
  printf 'matchplane_postgres_backup_prepare status=failed stage=requires_root\n' >&2
  exit 1
fi
if ! id -u postgres >/dev/null 2>&1 || ! id -g postgres >/dev/null 2>&1; then
  if [[ $allow_missing_postgres -eq 1 ]]; then
    printf 'matchplane_postgres_backup_prepare status=skipped stage=postgres_user_absent\n'
    exit 0
  fi
  printf 'matchplane_postgres_backup_prepare status=failed stage=postgres_user_absent\n' >&2
  exit 1
fi

[[ -d $backups_root && ! -L $backups_root ]] || {
  printf 'matchplane_postgres_backup_prepare status=failed stage=unsafe_directory\n' >&2
  exit 1
}
[[ $(realpath -e -- "$backups_root") == "$backups_root" ]] || {
  printf 'matchplane_postgres_backup_prepare status=failed stage=unsafe_directory\n' >&2
  exit 1
}
for path in "$backup_parent" "$backup_directory"; do
  if [[ -L $path ]]; then
    printf 'matchplane_postgres_backup_prepare status=failed stage=unsafe_directory\n' >&2
    exit 1
  fi
done

install -d -m 0711 -o root -g root -- "$backup_parent"
install -d -m 0700 -o postgres -g postgres -- "$backup_directory"

parent_canonical=$(realpath -e -- "$backup_parent")
directory_canonical=$(realpath -e -- "$backup_directory")
[[ $parent_canonical == "$backup_parent" && $directory_canonical == "$backup_directory" ]] || {
  printf 'matchplane_postgres_backup_prepare status=failed stage=unsafe_directory\n' >&2
  exit 1
}
metadata=$(stat -Lc '%U:%G:%a' -- "$backup_directory")
[[ $metadata == postgres:postgres:700 ]] || {
  printf 'matchplane_postgres_backup_prepare status=failed stage=unsafe_directory\n' >&2
  exit 1
}

printf 'matchplane_postgres_backup_prepare status=ok mode=0700 owner=postgres group=postgres\n'
