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
  matchplane-vector-worker
  xtask
)

install -d "$root/usr/bin" "$root/etc/matchplane" "$root/usr/lib/systemd/system"
if [[ ! -f $repository_root/web/dist/index.html ]]; then
  echo 'web/dist is missing; run npm ci and npm run build in web/' >&2
  exit 1
fi

install -d "$root/usr/lib/sysusers.d" "$root/usr/lib/tmpfiles.d" "$root/usr/share/doc/matchplane"
install -d "$root/usr/share/matchplane/web"
for binary in "${binaries[@]}"; do
  install -Dm0755 "$binary_directory/$binary" "$root/usr/bin/$binary"
done
install -Dm0640 "$repository_root/packaging/config/matchplane.env" "$root/etc/matchplane/matchplane.env"
install -Dm0644 "$repository_root"/packaging/systemd/*.service "$root/usr/lib/systemd/system/"
install -Dm0644 "$repository_root/packaging/sysusers/matchplane.conf" "$root/usr/lib/sysusers.d/matchplane.conf"
install -Dm0644 "$repository_root/packaging/tmpfiles/matchplane.conf" "$root/usr/lib/tmpfiles.d/matchplane.conf"
install -Dm0644 "$repository_root/README.md" "$root/usr/share/doc/matchplane/README.md"
install -Dm0644 "$repository_root/ARCHITECTURE.md" "$root/usr/share/doc/matchplane/ARCHITECTURE.md"
install -Dm0644 "$repository_root/docs/marketplace-payments.md" \
  "$root/usr/share/doc/matchplane/marketplace-payments.md"
cp -a "$repository_root/web/dist/." "$root/usr/share/matchplane/web/"
find "$root/usr/share/matchplane/web" -type d -exec chmod 0755 {} +
find "$root/usr/share/matchplane/web" -type f -exec chmod 0644 {} +
