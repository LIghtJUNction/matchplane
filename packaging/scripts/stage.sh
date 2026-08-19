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

install -d "$root/usr/bin" "$root/etc/matchplane" "$root/etc/matchplane/services" "$root/usr/lib/systemd/system"
install -d "$root/usr/lib/sysusers.d" "$root/usr/lib/tmpfiles.d" "$root/usr/share/doc/matchplane"
install -d "$root/usr/share/licenses/matchplane"
install -d "$root/usr/share/matchplane/web"
install -d "$root/usr/share/matchplane/skills"
standalone_root="$repository_root/web/.next/standalone"
if [[ -f "$standalone_root/server.js" ]]; then
  :
elif [[ -f "$standalone_root/web/server.js" ]]; then
  standalone_root="$standalone_root/web"
else
  echo 'Next standalone server.js is missing; run bun install and bun run build in web/' >&2
  exit 1
fi
for binary in "${binaries[@]}"; do
  install -Dm0755 "$binary_directory/$binary" "$root/usr/bin/$binary"
done
install -Dm0640 "$repository_root/packaging/config/matchplane.env" "$root/etc/matchplane/matchplane.env"
install -Dm0644 "$repository_root"/packaging/systemd/*.service "$root/usr/lib/systemd/system/"
install -Dm0644 "$repository_root/packaging/sysusers/matchplane.conf" "$root/usr/lib/sysusers.d/matchplane.conf"
install -Dm0644 "$repository_root/packaging/tmpfiles/matchplane.conf" "$root/usr/lib/tmpfiles.d/matchplane.conf"
install -Dm0644 "$repository_root/README.md" "$root/usr/share/doc/matchplane/README.md"
install -Dm0644 "$repository_root/LICENSE" "$root/usr/share/licenses/matchplane/LICENSE"
install -Dm0644 "$repository_root/ARCHITECTURE.md" "$root/usr/share/doc/matchplane/ARCHITECTURE.md"
install -Dm0644 "$repository_root/docs/marketplace-payments.md" \
  "$root/usr/share/doc/matchplane/marketplace-payments.md"
install -Dm0644 "$repository_root/docs/cli-and-mcp.md" \
  "$root/usr/share/doc/matchplane/cli-and-mcp.md"
cp -a "$repository_root/.agents/skills/." "$root/usr/share/matchplane/skills/"
# Next 16 can emit either a package-local standalone root or a monorepo-shaped
# `standalone/web` tree. In the latter layout the app's node_modules links point
# two levels up to `standalone/node_modules`. Keep the Bun store beside the
# flattened app and rewrite the one top-level `next` link to stay within that
# package-local tree. Leaving the link pointed at the build workspace makes
# Node's `createRequire` reject `next` during standalone bootstrap.
cp -a "$standalone_root/." "$root/usr/share/matchplane/web/"
standalone_parent=$(dirname "$standalone_root")
if [[ "$standalone_root" != "$repository_root/web/.next/standalone" && -d "$standalone_parent/node_modules/.bun" ]]; then
  install -d "$root/usr/share/matchplane/web/node_modules"
  cp -a "$standalone_parent/node_modules/.bun" \
    "$root/usr/share/matchplane/web/node_modules/.bun"
  staged_next="$root/usr/share/matchplane/web/node_modules/next"
  if [[ -L $staged_next ]]; then
    next_link=$(readlink "$staged_next")
    if [[ $next_link == ../../node_modules/.bun/* ]]; then
      next_fragment=${next_link#../../node_modules/.bun/}
      unlink "$staged_next"
      ln -s ".bun/$next_fragment" "$staged_next"
    fi
  fi
fi
# Bun's isolated linker can make Next's file tracer retain only the CJS half of
# `@swc/helpers`, while Next's standalone bootstrap still imports one ESM helper.
# Complete that one traced package from the locked install so the packaged Node
# process does not fail during module resolution.  The versioned `.bun` path is
# discovered rather than hard-coded, keeping this valid across dependency bumps.
staged_swc_helpers=$(find "$root/usr/share/matchplane/web/node_modules" \
  -type f -path '*/node_modules/@swc/helpers/package.json' -print -quit 2>/dev/null || true)
source_swc_helpers=$(find "$repository_root/node_modules" \
  -type f -path '*/node_modules/@swc/helpers/package.json' -print -quit 2>/dev/null || true)
if [[ -n $staged_swc_helpers && -n $source_swc_helpers ]]; then
  cp -a "$(dirname "$source_swc_helpers")/." "$(dirname "$staged_swc_helpers")/"
fi
if [[ -d $repository_root/web/public ]]; then
  cp -a "$repository_root/web/public/." "$root/usr/share/matchplane/web/public/"
fi
install -d "$root/usr/share/matchplane/web/.next/static"
cp -a "$repository_root/web/.next/static/." "$root/usr/share/matchplane/web/.next/static/"
find "$root/usr/share/matchplane/web" -type d -exec chmod 0755 {} +
find "$root/usr/share/matchplane/web" -type f -exec chmod 0644 {} +
