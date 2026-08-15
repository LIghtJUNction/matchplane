#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repository_root"

bash -n packaging/scripts/stage.sh packaging/scripts/archive.sh
bash -n packaging/ubuntu/build-deb.sh packaging/ubuntu/postinst packaging/ubuntu/prerm
bash -n packaging/fedora/build-rpm.sh
bash -n deploy/scripts/configure-ubuntu-host.sh
bash -n packaging/aur/matchplane-git/PKGBUILD
bash -n packaging/aur/matchplane-git/matchplane.install
bash -n packaging/aur/matchplane-bin/PKGBUILD.in
bash -n packaging/aur/matchplane-bin/matchplane.install

if command -v systemd-analyze >/dev/null 2>&1; then
  verify_output=$(systemd-analyze verify packaging/systemd/*.service 2>&1 || true)
  unexpected=$(printf '%s\n' "$verify_output" \
    | grep -Ev 'Command /usr/bin/(matchplane-[a-z-]+|xtask) is not executable: No such file or directory' \
    || true)
  if [[ -n $unexpected ]]; then
    printf '%s\n' "$unexpected" >&2
    exit 1
  fi
fi

if rg -q 'MATCHPLANE_NODE_ID=00000000-0000-7000-8000-00000000000a' \
  deploy/scripts/configure-ubuntu-host.sh packaging/config/matchplane.env; then
  echo 'production deployment templates must not persist the development node id' >&2
  exit 1
fi

if [[ ${MATCHPLANE_BUILD_PACKAGES:-0} == 1 ]]; then
  bun install --frozen-lockfile --cwd web
  bun run --cwd web check
  cargo build --release --locked --workspace --bins
  output_directory=$(mktemp -d)
  trap 'rm -rf "$output_directory"' EXIT
  packaging/scripts/archive.sh 0.1.8 target/release "$output_directory"
  tar --list --zstd --file "$output_directory/matchplane-0.1.8-linux-x86_64.tar.zst" >/dev/null
  if command -v dpkg-deb >/dev/null 2>&1; then
    packaging/ubuntu/build-deb.sh 0.1.8 target/release "$output_directory"
    dpkg-deb --info "$output_directory/matchplane_0.1.8_amd64.deb" >/dev/null
  fi
fi

echo 'packaging definitions validated'
