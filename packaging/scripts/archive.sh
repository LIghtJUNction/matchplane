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
archive_root="$work_directory/matchplane-$version-linux-x86_64"

"$repository_root/packaging/scripts/stage.sh" "$archive_root" "$binary_directory"
mkdir -p "$output_directory"
tar --create --zstd --file "$output_directory/matchplane-$version-linux-x86_64.tar.zst" \
  --directory "$work_directory" "matchplane-$version-linux-x86_64"
