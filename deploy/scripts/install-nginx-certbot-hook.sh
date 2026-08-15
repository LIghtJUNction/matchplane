#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
  echo 'install-nginx-certbot-hook.sh must run as root' >&2
  exit 1
fi

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
hook_path=/etc/letsencrypt/renewal-hooks/deploy/matchplane-nginx
install -D -m 0755 "$repository_root/deploy/nginx/reload-after-renewal" "$hook_path"

if systemctl cat certbot.timer >/dev/null 2>&1; then
  systemctl enable --now certbot.timer
else
  echo 'certbot.timer is not installed; install certbot before enabling certificate renewal' >&2
  exit 1
fi

systemctl is-enabled --quiet certbot.timer
systemctl is-active --quiet certbot.timer
printf 'installed %s and enabled certbot.timer\n' "$hook_path"
