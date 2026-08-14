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

if ! command -v bun >/dev/null 2>&1; then
  bun_version=${BUN_VERSION:-1.3.14}
  bun_directory=$(mktemp -d)
  trap 'rm -rf "$rpmbuild_root" "$bun_directory"' EXIT
  curl --fail --silent --show-error --location \
    "https://github.com/oven-sh/bun/releases/download/bun-v${bun_version}/bun-linux-x64.zip" \
    --output "$bun_directory/bun.zip"
  unzip -q "$bun_directory/bun.zip" -d "$bun_directory"
  export PATH="$bun_directory/bun-linux-x64:$PATH"
fi

mkdir -p "$rpmbuild_root"/{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS}
tar --create --directory "$repository_root" \
  --exclude=.git --exclude=target --exclude=dist --exclude=web/node_modules \
  --exclude=web/out --exclude=web/.next --exclude=web/dist --exclude='*.pkg.tar.*' \
  --transform="s,^\./,matchplane-$version/," . \
  | gzip -n >"$rpmbuild_root/SOURCES/matchplane-$version.tar.gz"
cp "$repository_root/packaging/fedora/matchplane.spec" "$rpmbuild_root/SPECS/"
cp "$repository_root/packaging/sysusers/matchplane.conf" "$rpmbuild_root/SOURCES/matchplane.conf"
rpmbuild --define "_topdir $rpmbuild_root" --define "matchplane_version $version" \
  -ba "$rpmbuild_root/SPECS/matchplane.spec"
mkdir -p "$output_directory"
find "$rpmbuild_root/RPMS" "$rpmbuild_root/SRPMS" -type f \
  \( -name '*.rpm' -o -name '*.src.rpm' \) -exec cp -t "$output_directory" {} +
