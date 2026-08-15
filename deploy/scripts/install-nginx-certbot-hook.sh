#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
  echo 'install-nginx-certbot-hook.sh must run as root' >&2
  exit 1
fi

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
hook_path=/etc/letsencrypt/renewal-hooks/deploy/matchplane-nginx
install -D -m 0755 "$repository_root/deploy/nginx/reload-after-renewal" "$hook_path"

renewal_timer=
for candidate in certbot.timer snap.certbot.renew.timer; do
  if systemctl cat "$candidate" >/dev/null 2>&1; then
    renewal_timer=$candidate
    break
  fi
done
if [[ -z $renewal_timer ]]; then
  echo 'no Certbot renewal timer is installed; install Certbot before enabling certificate renewal' >&2
  exit 1
fi

systemctl enable --now "$renewal_timer"
systemctl is-enabled --quiet "$renewal_timer"
systemctl is-active --quiet "$renewal_timer"
printf 'installed %s and enabled %s\n' "$hook_path" "$renewal_timer"
