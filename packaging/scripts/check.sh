#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repository_root"

bash -n packaging/scripts/stage.sh packaging/scripts/archive.sh
bash -n packaging/ubuntu/build-deb.sh packaging/ubuntu/postinst packaging/ubuntu/prerm
bash -n packaging/fedora/build-rpm.sh
bash -n deploy/scripts/configure-ubuntu-host.sh
bash -n deploy/scripts/install-kafka.sh
bash -n deploy/scripts/install-nginx-certbot-hook.sh
bash -n packaging/aur/matchplane-git/PKGBUILD.in
bash -n packaging/aur/matchplane-git/matchplane.install
bash -n packaging/aur/matchplane-bin/PKGBUILD.in
bash -n packaging/aur/matchplane-bin/matchplane.install

for service in web gateway payment-service event-relay matcher projector subplatform-builder vector-worker federation-hub; do
  unit="packaging/systemd/matchplane-${service}.service"
  if ! rg -q "^EnvironmentFile=/etc/matchplane/services/${service}\.env$" "$unit"; then
    echo "$unit must require its workload-scoped environment file" >&2
    exit 1
  fi
done
if ! rg -q '^EnvironmentFile=/etc/matchplane/services/migration\.env$' \
  packaging/systemd/matchplane-initialize.service; then
  echo 'matchplane-initialize.service must require the migration environment file' >&2
  exit 1
fi
for service_user in relay matcher projector builder vector federation migration; do
  if ! rg -q "^User=matchplane-${service_user}$" \
    packaging/systemd/matchplane-*.service; then
    echo "missing dedicated service user matchplane-${service_user}" >&2
    exit 1
  fi
done

if ! rg -q '^Environment=MATCHPLANE_WEB_NODE=/usr/bin/node$' \
  packaging/systemd/matchplane-web.service; then
  echo 'packaged web service must use the host nodejs path /usr/bin/node' >&2
  exit 1
fi
if ! rg -q '^Environment=MATCHPLANE_SUBPLATFORM_BUILDER_TOKEN_FILE=/etc/matchplane/secrets/web/builder\.token$' \
  packaging/systemd/matchplane-web.service; then
  echo 'web service must use its own builder-token copy' >&2
  exit 1
fi
if ! rg -q '^Environment=MATCHPLANE_SUBPLATFORM_BUILDER_TOKEN_FILE=/etc/matchplane/secrets/builder/builder\.token$' \
  packaging/systemd/matchplane-subplatform-builder.service; then
  echo 'builder service must use its isolated builder-token copy' >&2
  exit 1
fi

if rg -n --glob '*.Dockerfile' --glob 'Dockerfile*' \
  '^FROM [^$@[:space:]]+:[^@[:space:]]+( |$)' deploy packaging; then
  echo 'container build bases must be pinned by digest' >&2
  exit 1
fi

if ! rg -q '^ARG TIMESCALE_IMAGE=[^@[:space:]]+@sha256:[0-9a-f]{64}$' \
  deploy/compose/postgres/Dockerfile; then
  echo 'Timescale build base must have a sha256 digest' >&2
  exit 1
fi

if command -v systemd-analyze >/dev/null 2>&1; then
  verify_output=$(systemd-analyze verify packaging/systemd/*.service 2>&1 || true)
  unexpected=$(printf '%s\n' "$verify_output" \
    | grep -Ev 'Command (/usr/bin/node|/usr/bin/(matchplane|matchplane-[a-z-]+)) is not executable: No such file or directory' \
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

if rg -n '^MATCHPLANE_(DATABASE|VALKEY)_URL=' packaging/config/matchplane.env; then
  echo 'shared package environment must not contain workload database or Valkey URLs' >&2
  exit 1
fi

if [[ ${MATCHPLANE_BUILD_PACKAGES:-0} == 1 ]]; then
  package_version=$(awk -F'"' '$1 == "version = " { print $2; exit }' Cargo.toml)
  if [[ ! $package_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo 'workspace package version is malformed' >&2
    exit 1
  fi
  bun install --frozen-lockfile --cwd web
  bun run --cwd web check
  cargo build --release --locked --workspace --bins
  output_directory=$(mktemp -d)
  trap 'rm -rf "$output_directory"' EXIT
  packaging/scripts/archive.sh "$package_version" target/release "$output_directory"
  tar --list --zstd --file "$output_directory/matchplane-$package_version-linux-x86_64.tar.zst" >/dev/null
  if command -v dpkg-deb >/dev/null 2>&1; then
    packaging/ubuntu/build-deb.sh "$package_version" target/release "$output_directory"
    dpkg-deb --info "$output_directory/matchplane_${package_version}_amd64.deb" >/dev/null
  fi
fi

echo 'packaging definitions validated'
