#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 VERSION BINARY_DIRECTORY OUTPUT_DIRECTORY" >&2
  exit 2
fi

version=$1
binary_directory=$2
output_directory=$3
repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
work_directory=$(mktemp -d)
trap 'rm -rf "$work_directory"' EXIT
package_root="$work_directory/matchplane_${version}_amd64"

"$repository_root/packaging/scripts/stage.sh" "$package_root" "$binary_directory"
install -d "$package_root/DEBIAN"
installed_size=$(du -sk "$package_root" | cut -f1)
sed \
  -e "s/__VERSION__/$version/g" \
  -e "s/__INSTALLED_SIZE__/$installed_size/g" \
  "$repository_root/packaging/ubuntu/control.in" >"$package_root/DEBIAN/control"
install -Dm0755 "$repository_root/packaging/ubuntu/postinst" "$package_root/DEBIAN/postinst"
install -Dm0755 "$repository_root/packaging/ubuntu/prerm" "$package_root/DEBIAN/prerm"
printf '%s\n' \
  '/etc/matchplane/matchplane.env' \
  '/etc/matchplane/postgres-backup.conf' >"$package_root/DEBIAN/conffiles"
mkdir -p "$output_directory"
dpkg-deb --root-owner-group --build "$package_root" \
  "$output_directory/matchplane_${version}_amd64.deb"
