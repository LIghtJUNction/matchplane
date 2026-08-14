#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 VERSION OUTPUT_DIRECTORY" >&2
  exit 2
fi

version=$1
output_directory=$2
repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
rpmbuild_root=$(mktemp -d)
trap 'rm -rf "$rpmbuild_root"' EXIT

mkdir -p "$rpmbuild_root"/{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS}
tar --create --directory "$repository_root" \
  --exclude=.git --exclude=target --exclude=dist --exclude=web/node_modules \
  --exclude=web/dist --exclude='*.pkg.tar.*' \
  --transform="s,^\./,matchplane-$version/," . \
  | gzip -n >"$rpmbuild_root/SOURCES/matchplane-$version.tar.gz"
cp "$repository_root/packaging/fedora/matchplane.spec" "$rpmbuild_root/SPECS/"
cp "$repository_root/packaging/sysusers/matchplane.conf" "$rpmbuild_root/SOURCES/matchplane.conf"
rpmbuild --define "_topdir $rpmbuild_root" --define "matchplane_version $version" \
  -ba "$rpmbuild_root/SPECS/matchplane.spec"
mkdir -p "$output_directory"
find "$rpmbuild_root/RPMS" "$rpmbuild_root/SRPMS" -type f \
  \( -name '*.rpm' -o -name '*.src.rpm' \) -exec cp -t "$output_directory" {} +
