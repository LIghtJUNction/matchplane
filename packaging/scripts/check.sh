#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repository_root"

backup_gate_shell_sources=(
  packaging/scripts/postgres-backup.sh
  packaging/scripts/postgres-backup-prepare.sh
  packaging/scripts/postgres-backup-verify.sh
  tests/operations/postgres-backup-gate.sh
)

bash -n packaging/scripts/stage.sh packaging/scripts/archive.sh \
  packaging/scripts/check-conversion-recovery-permissions.sh
bash -n deploy/helm/matchplane/tests/conversion-projector-probe.sh
bash -n "${backup_gate_shell_sources[@]}"
bash -n packaging/ubuntu/build-deb.sh packaging/ubuntu/postinst packaging/ubuntu/prerm
bash -n packaging/fedora/build-rpm.sh
bash -n deploy/scripts/configure-ubuntu-host.sh
bash -n deploy/scripts/prepare-compose-router-state.sh
bash -n deploy/scripts/install-kafka.sh
bash -n deploy/scripts/install-nginx-certbot-hook.sh
bash -n deploy/scripts/install-bun.sh
bash -n packaging/aur/matchplane-git/PKGBUILD.in
bash -n packaging/aur/matchplane-git/matchplane.install
bash -n packaging/aur/matchplane-bin/PKGBUILD.in
bash -n packaging/aur/matchplane-bin/matchplane.install

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "${backup_gate_shell_sources[@]}"
fi
if command -v shfmt >/dev/null 2>&1; then
  shfmt -d -i 2 -ci "${backup_gate_shell_sources[@]}"
fi

for service in web gateway payment-service event-relay conversion-projector matcher projector subplatform-builder vector-worker federation-hub; do
  unit="packaging/systemd/matchplane-${service}.service"
  if ! rg -q "^EnvironmentFile=/etc/matchplane/services/${service}\.env$" "$unit"; then
    echo "$unit must require its workload-scoped environment file" >&2
    exit 1
  fi
done
python3 - <<'PY'
from pathlib import Path

source = Path("deploy/scripts/configure-ubuntu-host.sh").read_text(encoding="utf-8")
function = source.split("write_service_environment() {", 1)[1].split("\n}", 1)[0]
guard = "if [[ $service != conversion-projector ]]; then"
guard_start = function.index(guard)
guard_end = function.index("\n    fi", guard_start)
valkey = function.index("MATCHPLANE_VALKEY_URL")
assert guard_start < valkey < guard_end, (
    "conversion projector host environment must not receive MATCHPLANE_VALKEY_URL"
)
PY
if ! rg -q '^EnvironmentFile=/etc/matchplane/services/migration\.env$' \
  packaging/systemd/matchplane-initialize.service; then
  echo 'matchplane-initialize.service must require the migration environment file' >&2
  exit 1
fi
for service_user in relay conversion matcher projector builder vector federation migration; do
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
if rg -q '^(BETTER_AUTH_SECRET|MATCHPLANE_ROUTER_AI_KEY)=' \
  packaging/config/matchplane.env; then
  echo 'web-only secrets must not be declared in the shared production environment' >&2
  exit 1
fi
for secret_environment in better-auth router-ai; do
  if ! rg -q "^EnvironmentFile=-/etc/matchplane/secrets/web/${secret_environment}\\.env$" \
    packaging/systemd/matchplane-web.service; then
    echo "web service must load the isolated ${secret_environment} secret environment" >&2
    exit 1
  fi
done
if ! rg -q '^Environment=MATCHPLANE_SUBPLATFORM_BUILDER_TOKEN_FILE=/etc/matchplane/secrets/builder/builder\.token$' \
  packaging/systemd/matchplane-subplatform-builder.service; then
  echo 'builder service must use its isolated builder-token copy' >&2
  exit 1
fi
if ! rg -q '^ConditionPathExists=/etc/matchplane/services/subplatform-builder\.env$' \
  packaging/systemd/matchplane-subplatform-builder.service ||
  ! rg -q '^ConditionPathExists=/etc/matchplane/secrets/builder/builder\.token$' \
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
  packaging/tmpfiles/matchplane.conf ||
  ! rg -q '^ReadWritePaths=.* /var/lib/matchplane/media( |$)' \
    packaging/systemd/matchplane-web.service; then
  echo 'hosted store media must be private and writable by the web service' >&2
  exit 1
fi
if ! rg -q '^d /etc/matchplane/recovery 0750 root root -$' \
  packaging/tmpfiles/matchplane.conf; then
  echo 'conversion recovery credentials require a root-only directory' >&2
  exit 1
fi
packaging/scripts/check-conversion-recovery-permissions.sh
if command -v helm >/dev/null 2>&1; then
  deploy/helm/matchplane/tests/conversion-projector-probe.sh
fi

backup_unit=packaging/systemd/matchplane-postgres-backup.service
backup_timer=packaging/systemd/matchplane-postgres-backup.timer
for directive in \
  '^User=postgres$' '^Group=postgres$' '^UMask=0077$' \
  '^RestrictAddressFamilies=AF_UNIX$' '^ProtectSystem=strict$' \
  '^PrivateTmp=true$' '^PrivateNetwork=true$' '^NoNewPrivileges=true$' \
  '^ReadOnlyPaths=/run/postgresql$' \
  '^ReadWritePaths=/var/backups/matchplane/postgres$'; do
  if ! rg -q "$directive" "$backup_unit"; then
    echo "PostgreSQL backup service is missing hardening directive $directive" >&2
    exit 1
  fi
done
if ! rg -q '^Persistent=true$' "$backup_timer" ||
  ! rg -q '^RandomizedDelaySec=45m$' "$backup_timer"; then
  echo 'PostgreSQL backup timer must be persistent and randomized' >&2
  exit 1
fi
if ! rg -q '^d /var/backups/matchplane/postgres 0700 - - -$' \
  packaging/tmpfiles/matchplane.conf; then
  echo 'PostgreSQL backup directory must be staged with mode 0700' >&2
  exit 1
fi
backup_config_entries=$(grep -Ev '^[[:space:]]*(#|$)' packaging/config/postgres-backup.conf)
if [[ $backup_config_entries != MATCHPLANE_POSTGRES_BACKUP_RETENTION_DAYS=14 ]]; then
  echo 'PostgreSQL backup config may contain only the retention window' >&2
  exit 1
fi
if rg -q 'systemctl (enable|preset).*matchplane-postgres-backup' \
  deploy/scripts/configure-ubuntu-host.sh packaging/ubuntu/postinst \
  packaging/aur/*/matchplane.install packaging/fedora/matchplane.spec; then
  echo 'package and development installation must not enable the PostgreSQL backup timer' >&2
  exit 1
fi
for staged_path in \
  '/usr/libexec/matchplane-postgres-backup' \
  '/usr/sbin/matchplane-postgres-backup-prepare' \
  '/usr/bin/matchplane-postgres-backup-verify' \
  'packaging/systemd/\*\.timer' \
  'postgres-backup.conf' \
  'liquid-gooey\.LICENSE' \
  'metal-fx\.LICENSE' \
  'web-THIRD_PARTY_NOTICES\.md'; do
  if ! rg -q "$staged_path" packaging/scripts/stage.sh; then
    echo "packaging stage is missing $staged_path" >&2
    exit 1
  fi
done
if ! rg -Fq '%license %{_datadir}/licenses/matchplane/metal-fx.LICENSE' \
  packaging/fedora/matchplane.spec; then
  echo 'the Fedora package must list the metal-fx license' >&2
  exit 1
fi
metal_patch=patches/metal-fx@1.0.4.patch
web_metal_patch=web/patches/metal-fx@1.0.4.patch
for patch_path in "$metal_patch" "$web_metal_patch"; do
  if [[ ! -f $patch_path ]]; then
    echo "required metal-fx patch is missing: $patch_path" >&2
    exit 1
  fi
done
if ! cmp -s "$metal_patch" "$web_metal_patch"; then
  echo 'root and web metal-fx patches must be identical' >&2
  exit 1
fi
if ! rg -Fq '"$repository_root"/docs/*.json' packaging/scripts/stage.sh; then
  echo 'staging must include all public Agent and subplatform JSON contracts' >&2
  exit 1
fi
if ! rg -Fq '%{_docdir}/matchplane/*.json' packaging/fedora/matchplane.spec; then
  echo 'the Fedora package must own every staged public JSON contract' >&2
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
  verify_output=$(systemd-analyze verify packaging/systemd/*.service packaging/systemd/*.timer 2>&1 || true)
  unexpected=$(printf '%s\n' "$verify_output" |
    grep -Ev 'Command (/usr/bin/node|/usr/bin/(matchplane|matchplane-[a-z-]+)|/usr/libexec/matchplane-postgres-backup) is not executable:' ||
    true)
  if [[ -n $unexpected ]]; then
    printf '%s\n' "$unexpected" >&2
    exit 1
  fi

  # Verify the new unit/timer as installed. The repository cannot populate the
  # absolute packaged ExecStart path, so a test-only drop-in substitutes true;
  # stage assertions above separately pin that packaged path.
  systemd_verify_directory=$(mktemp -d)
  cp packaging/systemd/matchplane-postgres-backup.service \
    packaging/systemd/matchplane-postgres-backup.timer "$systemd_verify_directory/"
  install -d "$systemd_verify_directory/matchplane-postgres-backup.service.d"
  printf '[Service]\nExecStart=\nExecStart=/usr/bin/true\n' \
    >"$systemd_verify_directory/matchplane-postgres-backup.service.d/verify.conf"
  if ! SYSTEMD_UNIT_PATH="$systemd_verify_directory:/usr/lib/systemd/system" \
    systemd-analyze verify matchplane-postgres-backup.service \
    matchplane-postgres-backup.timer; then
    rm -rf "$systemd_verify_directory"
    exit 1
  fi
  rm -rf "$systemd_verify_directory"
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

tests/operations/postgres-backup-gate.sh

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
