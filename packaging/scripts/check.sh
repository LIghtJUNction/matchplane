#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repository_root"

bash -n packaging/scripts/stage.sh packaging/scripts/archive.sh
bash -n packaging/ubuntu/build-deb.sh packaging/ubuntu/postinst packaging/ubuntu/prerm
bash -n packaging/fedora/build-rpm.sh
bash -n deploy/scripts/configure-ubuntu-host.sh
bash -n deploy/scripts/install-kafka.sh
bash -n deploy/scripts/install-nginx-certbot-hook.sh
bash -n deploy/scripts/install-bun.sh
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
if rg -q '^Environment=MATCHPLANE_ENVIRONMENT=' packaging/systemd/matchplane-web.service; then
  echo 'web service must not hard-code a deployment environment; use matchplane.env' >&2
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
if ! rg -q '^ConditionPathExists=/etc/matchplane/services/subplatform-builder\.env$' \
  packaging/systemd/matchplane-subplatform-builder.service \
  || ! rg -q '^ConditionPathExists=/etc/matchplane/secrets/builder/builder\.token$' \
  packaging/systemd/matchplane-subplatform-builder.service; then
  echo 'optional builder service must fail closed when its environment or token is absent' >&2
  exit 1
fi
if ! rg -q '^d /var/lib/matchplane/subplatform-artifacts 0750 matchplane-builder matchplane-web -$' \
  packaging/tmpfiles/matchplane.conf; then
  echo 'immutable builder artifacts must be writable by the isolated builder and readable by web' >&2
  exit 1
fi
if ! rg -q '^d /var/lib/matchplane/media 0750 matchplane-web matchplane-web -$' \
  packaging/tmpfiles/matchplane.conf \
  || ! rg -q '^ReadWritePaths=.* /var/lib/matchplane/media( |$)' \
  packaging/systemd/matchplane-web.service; then
  echo 'hosted store media must be private and writable by the web service' >&2
  exit 1
fi

router_state_root='/etc/matchplane/secrets/root-email'
if ! rg -q '^d /etc/matchplane/secrets/root-email 0770 root matchplane-web -$' \
  packaging/tmpfiles/matchplane.conf \
  || ! rg -q '^install -d -m 0770 -o root -g matchplane-web /etc/matchplane/secrets/root-email$' \
  deploy/scripts/configure-ubuntu-host.sh \
  || ! rg -q '^ReadWritePaths=.* /etc/matchplane/secrets/root-email( |$)' \
  packaging/systemd/matchplane-web.service; then
  echo 'platform-router state root must be root:matchplane-web 0770 and writable only by Web' >&2
  exit 1
fi
if ! rg -q 'mkdirSync\(directory, \{ mode: 0o750 \}\);' \
  web/src/lib/platform-router-config/transaction.ts \
  || ! rg -q 'writeExclusiveFile\(generationTemporary, generationBytes, 0o640, environment\);' \
  web/src/lib/platform-router-config/transaction.ts \
  || ! rg -q 'fchmodSync\(descriptor, 0o640\);' \
  web/src/lib/platform-router-config/protected-storage.ts; then
  echo 'Web must remain the runtime owner of 0750 generation directories and 0640 state files' >&2
  exit 1
fi
if rg -q "^[^d#].*${router_state_root}" packaging/tmpfiles/matchplane.conf \
  || rg -q 'root-email|platform-router' packaging/systemd --glob '*.timer'; then
  echo 'platform-router credential temporaries must not be removed by tmpfiles or a cleanup timer' >&2
  exit 1
fi
if ! rg -q 'Credential-shaped temporary files are not age-cleaned by tmpfiles or a systemd timer' \
  docs/platform-router-state-storage.md; then
  echo 'platform-router storage documentation must preserve the no-age-cleanup contract' >&2
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
  archive_path="$output_directory/matchplane-$package_version-linux-x86_64.tar.zst"
  tar --list --zstd --file "$archive_path" >/dev/null
  archive_root=$(mktemp -d)
  tar --extract --zstd --file "$archive_path" --directory "$archive_root"
  packaged_web="$archive_root/usr/share/matchplane/web"
  node -e "const p=process.argv[1]; require.resolve('next/package.json',{paths:[p]})" "$packaged_web"
  staged_swc_helpers=$(find "$archive_root/usr/share/matchplane/web/node_modules" \
    -type f -path '*/node_modules/@swc/helpers/esm/_interop_require_default.js' \
    -print -quit 2>/dev/null || true)
  if [[ -z $staged_swc_helpers ]]; then
    echo 'portable archive is missing the Next standalone @swc/helpers ESM runtime' >&2
    exit 1
  fi
  find "$archive_root" -depth -delete
  if command -v dpkg-deb >/dev/null 2>&1; then
    packaging/ubuntu/build-deb.sh "$package_version" target/release "$output_directory"
    dpkg-deb --info "$output_directory/matchplane_${package_version}_amd64.deb" >/dev/null
  fi
fi

echo 'packaging definitions validated'
