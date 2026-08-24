#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
compose_directory="$repository_root/deploy/compose"
state_root=${MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT:-../../var/platform-router-state}
web_uid=${MATCHPLANE_COMPOSE_WEB_UID:-1000}
web_gid=${MATCHPLANE_COMPOSE_WEB_GID:-1000}

if [[ $state_root != /* ]]; then
	state_root="$compose_directory/$state_root"
fi
state_root=$(realpath -m -- "$state_root")

if [[ ! $web_uid =~ ^[0-9]+$ || ! $web_gid =~ ^[0-9]+$ ]]; then
	echo 'MATCHPLANE_COMPOSE_WEB_UID and MATCHPLANE_COMPOSE_WEB_GID must be numeric' >&2
	exit 1
fi
if [[ $(id -u) -ne 0 ]]; then
	echo 'prepare-compose-router-state.sh must run as root so bind ownership is deterministic' >&2
	exit 1
fi

# install -d repairs only the mount root metadata. Existing generations, pointers, audit records,
# and credential slots are preserved byte-for-byte and remain owned by the Web runtime identity.
install -d -m 0770 -o "$web_uid" -g "$web_gid" "$state_root"
printf 'prepared %s for Compose Web uid:gid %s:%s (mode 0770)\n' \
	"$state_root" "$web_uid" "$web_gid"
