#!/usr/bin/env bash
set -euo pipefail

# Install the latest stable Bun release for the isolated subplatform builder.
# The package deliberately does not select a Bun version: the operator may run
# this script again to refresh the runtime, while each subplatform build remains
# immutable because its source and artifact digests are recorded by MatchPlane.

if [[ $(id -u) -ne 0 ]]; then
  echo 'install-bun.sh must run as root' >&2
  exit 1
fi

install_root=${MATCHPLANE_BUN_INSTALL_ROOT:-/opt/bun-stable}
if [[ ! $install_root = /* || $install_root == */ || $install_root == *'..'* ]]; then
  echo 'MATCHPLANE_BUN_INSTALL_ROOT must be an absolute path without traversal' >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
if ! command -v curl >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install --yes --no-install-recommends ca-certificates curl
fi
if ! command -v unzip >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install --yes --no-install-recommends unzip
fi

install -d -m 0755 -o root -g root "$install_root"
installer=$(mktemp /var/tmp/matchplane-bun-install.XXXXXX)
trap 'rm -f "$installer"' EXIT

# This is the command published by Bun's installation guide. Download first so
# a failed transfer cannot be interpreted as a shell program.
curl --fail --silent --show-error --location \
  --proto '=https' --tlsv1.2 \
  https://bun.com/install --output "$installer"
chmod 0755 "$installer"

# BUN_INSTALL selects the system location. A non-interactive shell keeps the
# official script from modifying an operator's shell profile.
BUN_INSTALL="$install_root" HOME=/var/lib/matchplane-builder SHELL=/bin/sh \
  bash "$installer"

bun_path="$install_root/bin/bun"
if [[ ! -x $bun_path ]]; then
  echo "Bun installer did not produce $bun_path" >&2
  exit 1
fi
chown root:root "$bun_path"
chmod 0755 "$bun_path"

printf 'installed Bun %s (%s) at %s\n' \
  "$($bun_path --version)" "$($bun_path --revision)" "$bun_path"
