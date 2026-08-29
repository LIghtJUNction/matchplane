#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 ROOT BINARY_DIRECTORY" >&2
  exit 2
fi

root=$1
binary_directory=$2
repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
binaries=(
  matchplane-conversion-projector
  matchplane-event-relay
  matchplane-federation-hub
  matchplane-gateway
  matchplane-matcher
  matchplane-payment-service
  matchplane-projector
  matchplane-subplatform-builder
  matchplane-vector-worker
  matchplane
)

install -d "$root/usr/bin" "$root/usr/sbin" "$root/usr/libexec"
install -d "$root/etc/matchplane" "$root/etc/matchplane/services" "$root/usr/lib/systemd/system"
install -d "$root/usr/lib/sysusers.d" "$root/usr/lib/tmpfiles.d" "$root/usr/share/doc/matchplane"
install -d "$root/usr/share/licenses/matchplane"
install -d "$root/usr/share/matchplane/web"
install -d "$root/usr/share/matchplane/skills"
# A caller can use `mktemp -d` for the staging root. Make the packaged release
# traversable by service users after it is moved below the releases directory.
chmod 0755 "$root"
standalone_root="$repository_root/web/.next/standalone"
if [[ -f "$standalone_root/server.js" ]]; then
  standalone_web_root="$standalone_root"
elif [[ -f "$standalone_root/web/server.js" ]]; then
  standalone_web_root="$standalone_root/web"
else
  echo 'Next standalone server.js is missing; run bun install and bun run build in web/' >&2
  exit 1
fi
for binary in "${binaries[@]}"; do
  install -Dm0755 "$binary_directory/$binary" "$root/usr/bin/$binary"
done
install -Dm0640 "$repository_root/packaging/config/matchplane.env" "$root/etc/matchplane/matchplane.env"
install -Dm0644 "$repository_root/packaging/config/postgres-backup.conf" \
  "$root/etc/matchplane/postgres-backup.conf"
install -Dm0755 "$repository_root/packaging/scripts/postgres-backup.sh" \
  "$root/usr/libexec/matchplane-postgres-backup"
install -Dm0755 "$repository_root/packaging/scripts/postgres-backup-prepare.sh" \
  "$root/usr/sbin/matchplane-postgres-backup-prepare"
install -Dm0755 "$repository_root/packaging/scripts/postgres-backup-verify.sh" \
  "$root/usr/bin/matchplane-postgres-backup-verify"
install -Dm0644 "$repository_root"/packaging/systemd/*.service "$root/usr/lib/systemd/system/"
install -Dm0644 "$repository_root"/packaging/systemd/*.timer "$root/usr/lib/systemd/system/"
install -Dm0644 "$repository_root/packaging/sysusers/matchplane.conf" "$root/usr/lib/sysusers.d/matchplane.conf"
install -Dm0644 "$repository_root/packaging/tmpfiles/matchplane.conf" "$root/usr/lib/tmpfiles.d/matchplane.conf"
install -Dm0644 "$repository_root/README.md" "$root/usr/share/doc/matchplane/README.md"
install -Dm0644 "$repository_root/LICENSE" "$root/usr/share/licenses/matchplane/LICENSE"
install -Dm0644 "$repository_root/web/licenses/liquid-gooey.LICENSE" \
  "$root/usr/share/licenses/matchplane/liquid-gooey.LICENSE"
install -Dm0644 "$repository_root/web/licenses/metal-fx.LICENSE" \
  "$root/usr/share/licenses/matchplane/metal-fx.LICENSE"
install -Dm0644 "$repository_root/web/THIRD_PARTY_NOTICES.md" \
  "$root/usr/share/doc/matchplane/web-THIRD_PARTY_NOTICES.md"
install -Dm0644 "$repository_root/ARCHITECTURE.md" "$root/usr/share/doc/matchplane/ARCHITECTURE.md"
install -Dm0644 "$repository_root/docs/marketplace-payments.md" \
  "$root/usr/share/doc/matchplane/marketplace-payments.md"
install -Dm0644 "$repository_root/docs/cli-and-mcp.md" \
  "$root/usr/share/doc/matchplane/cli-and-mcp.md"
install -Dm0644 "$repository_root/docs/postgresql-backup-gate.md" \
  "$root/usr/share/doc/matchplane/postgresql-backup-gate.md"
# Ship every public machine-readable contract used by Agent and subplatform integrators. Keeping
# this as a source glob makes a newly added protocol fail visible in the release artifact by default.
for contract in "$repository_root"/docs/*.json; do
  install -Dm0644 "$contract" \
    "$root/usr/share/doc/matchplane/$(basename "$contract")"
done
cp -a "$repository_root/.agents/skills/." "$root/usr/share/matchplane/skills/"
cp -a "$standalone_web_root/." "$root/usr/share/matchplane/web/"
# Next can place the standalone server below the traced runtime while keeping
# its Bun store one directory up. Preserve both supported layouts, then repair
# only package-local links so the staged server never resolves build-workspace paths.
if [[ "$standalone_web_root" != "$standalone_root" && -d "$standalone_root/node_modules" ]]; then
  cp -a "$standalone_root/node_modules" "$root/usr/share/matchplane/"
  install -d "$root/usr/share/matchplane/web/node_modules"
  cp -a "$standalone_root/node_modules/.bun" \
    "$root/usr/share/matchplane/web/node_modules/.bun"
fi
# Turbopack names external packages with a content hash (for example
# `pg-074a390aaed10fa4`) in the standalone server chunks. Create those aliases
# from the locked Bun links instead of assuming that the tracer will emit them.
external_aliases=$(grep -RhoE '"[A-Za-z0-9@._/-]+-[0-9a-f]{14,}"' \
  "$repository_root/web/.next/server" 2>/dev/null |
  sed -E 's/^"|"$//g' | sort -u || true)
for external_alias in $external_aliases; do
  package_name=$(printf '%s\n' "$external_alias" | sed -E 's/-[0-9a-f]{14,}$//')
  source_link="$repository_root/web/node_modules/$package_name"
  [[ -L $source_link ]] || continue
  package_link=$(readlink "$source_link")
  [[ $package_link == ../../node_modules/.bun/* ]] || continue
  package_fragment=${package_link#../../node_modules/.bun/}
  alias_path="$root/usr/share/matchplane/web/node_modules/$external_alias"
  install -d "$(dirname "$alias_path")"
  [[ -e $alias_path || -L $alias_path ]] ||
    ln -s ".bun/$package_fragment" "$alias_path"
done
# Bun's isolated linker can make Next's file tracer retain only the CJS half of
# `@swc/helpers`, while Next's standalone bootstrap still imports one ESM helper.
# Complete that one traced package from the locked install so the packaged Node
# process does not fail during module resolution.  The versioned `.bun` path is
# discovered rather than hard-coded, keeping this valid across dependency bumps.
source_swc_helpers=$(find "$repository_root/node_modules" \
  -type f -path '*/node_modules/@swc/helpers/package.json' -print -quit 2>/dev/null || true)
if [[ -n $source_swc_helpers ]]; then
  while IFS= read -r staged_swc_helpers; do
    cp -a "$(dirname "$source_swc_helpers")/." "$(dirname "$staged_swc_helpers")/"
  done < <(find "$root/usr/share/matchplane" \
    -type f -path '*/node_modules/@swc/helpers/package.json' -print 2>/dev/null)
fi
if [[ -d $repository_root/web/public ]]; then
  cp -a "$repository_root/web/public/." "$root/usr/share/matchplane/web/public/"
fi
install -d "$root/usr/share/matchplane/web/.next/static"
cp -a "$repository_root/web/.next/static/." "$root/usr/share/matchplane/web/.next/static/"
find "$root/usr/share/matchplane/web" -type d -exec chmod 0755 {} +
find "$root/usr/share/matchplane/web" -type f -exec chmod 0644 {} +
if [[ -d "$root/usr/share/matchplane/node_modules" ]]; then
  find "$root/usr/share/matchplane/node_modules" -type d -exec chmod 0755 {} +
  find "$root/usr/share/matchplane/node_modules" -type f -exec chmod 0644 {} +
fi
