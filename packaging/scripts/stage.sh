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
cp -a "$standalone_web_root/." "$root/usr/share/matchplane/web/"
# Next can place the standalone server one directory below the traced runtime
# (for example `.next/standalone/web/server.js`) while keeping its traced
# `node_modules` beside that directory. Keep the runtime package next to the
# copied server so Node can resolve `next` and the other traced dependencies.
if [[ "$standalone_web_root" != "$standalone_root" && -d "$standalone_root/node_modules" ]]; then
  cp -a "$standalone_root/node_modules" "$root/usr/share/matchplane/"
  # Next's standalone tracer can retain the @swc/helpers package manifest but
  # omit its ESM helper files. Overlay the package from the locked workspace
  # install so the Node runtime can resolve the export selected by next.
  shopt -s nullglob
  for swc_helpers in "$repository_root"/node_modules/.bun/@swc+helpers@*; do
    cp -a "$swc_helpers" "$root/usr/share/matchplane/node_modules/.bun/"
  done
  shopt -u nullglob
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
