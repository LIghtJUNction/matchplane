#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
web_uid=${MATCHPLANE_COMPOSE_WEB_UID:-1000}
web_gid=${MATCHPLANE_COMPOSE_WEB_GID:-1000}
operator_uid=${MATCHPLANE_COMPOSE_OPERATOR_UID:-${SUDO_UID:-0}}
validation_only=0

if [[ $# -gt 1 || ($# -eq 1 && $1 != --validate-only) ]]; then
	echo 'usage: prepare-compose-router-state.sh [--validate-only]' >&2
	exit 2
fi
if [[ $# -eq 1 ]]; then
	validation_only=1
fi
if [[ ! $web_uid =~ ^[0-9]+$ || ! $web_gid =~ ^[0-9]+$ ]]; then
	echo 'MATCHPLANE_COMPOSE_WEB_UID and MATCHPLANE_COMPOSE_WEB_GID must be numeric' >&2
	exit 1
fi
if [[ ! $operator_uid =~ ^[0-9]+$ ]]; then
	echo 'MATCHPLANE_COMPOSE_OPERATOR_UID must be numeric' >&2
	exit 1
fi
if [[ $(id -u) -ne 0 ]]; then
	echo 'prepare-compose-router-state.sh must run as root so bind ownership is deterministic' >&2
	exit 1
fi

if [[ -n ${MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT:-} ]]; then
	state_root=$MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT
	path_mode=external
else
	state_root="$repository_root/var/platform-router-state"
	path_mode=repository-default
fi

python3 - \
	"$repository_root" "$state_root" "$path_mode" "$web_uid" "$web_gid" \
	"$operator_uid" "$validation_only" <<'PY'
import errno
import os
import stat
import sys

(
    repository_root,
    requested_root,
    path_mode,
    uid_text,
    gid_text,
    operator_uid_text,
    validation_only_text,
) = sys.argv[1:]

try:
    uid = int(uid_text, 10)
    gid = int(gid_text, 10)
    operator_uid = int(operator_uid_text, 10)
except ValueError as error:
    raise SystemExit(f"invalid uid/gid: {error}") from error
if not all(0 <= identifier <= 4_294_967_294 for identifier in (uid, gid, operator_uid)):
    raise SystemExit("Compose uid/gid values are outside the supported range")
validation_only = validation_only_text == "1"
if os.geteuid() != 0:
    raise SystemExit("prepare-compose-router-state.sh must run as root")

if path_mode == "repository-default":
    requested_root = os.path.join(repository_root, "var", "platform-router-state")
elif requested_root.startswith("//"):
    # POSIX permits implementation-defined handling for exactly two leading slashes, and
    # normpath deliberately preserves them. Refuse before normalization or filesystem access.
    raise SystemExit(
        "MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT must not begin with multiple slashes"
    )
elif not os.path.isabs(requested_root):
    raise SystemExit("MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT must be an absolute path")

state_root = os.path.normpath(requested_root)
sensitive_roots = {
    "/",
    "/bin",
    "/boot",
    "/dev",
    "/etc",
    "/home",
    "/lib",
    "/lib32",
    "/lib64",
    "/lost+found",
    "/opt",
    "/proc",
    "/root",
    "/run",
    "/sbin",
    "/srv",
    "/sys",
    "/tmp",
    "/usr",
    "/var",
}
if state_root in sensitive_roots:
    raise SystemExit(f"refusing unsafe platform-router state root: {state_root}")
if validation_only:
    print(f"validated platform-router state root: {state_root}")
    raise SystemExit(0)

open_flags = os.O_RDONLY | os.O_DIRECTORY
if hasattr(os, "O_CLOEXEC"):
    open_flags |= os.O_CLOEXEC
if hasattr(os, "O_NOFOLLOW"):
    open_flags |= os.O_NOFOLLOW


def open_child(parent_fd: int, component: str, display_path: str) -> int:
    try:
        return os.open(component, open_flags, dir_fd=parent_fd)
    except OSError as error:
        if error.errno in {errno.ELOOP, errno.ENOTDIR}:
            raise SystemExit(
                f"refusing symlink or non-directory path component: {display_path}"
            ) from error
        raise


trusted_parent_uids = {0, operator_uid}


def validate_trusted_parent(descriptor: int, display_path: str) -> None:
    metadata = os.fstat(descriptor)
    if metadata.st_uid not in trusted_parent_uids:
        raise SystemExit(
            f"parent directory is not owned by root or the trusted operator: {display_path}"
        )
    if stat.S_IMODE(metadata.st_mode) & 0o022:
        raise SystemExit(f"parent directory is group/world writable: {display_path}")


def walk_existing(absolute_path: str) -> int:
    descriptor = os.open("/", open_flags)
    current = ""
    try:
        validate_trusted_parent(descriptor, "/")
        for component in [part for part in absolute_path.split("/") if part]:
            current = f"{current}/{component}"
            try:
                child = open_child(descriptor, component, current)
            except FileNotFoundError as error:
                raise SystemExit(f"required parent directory does not exist: {current}") from error
            try:
                validate_trusted_parent(child, current)
            except BaseException:
                os.close(child)
                raise
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def create_and_open(
    parent_fd: int, component: str, display_path: str, create_mode: int = 0o770
) -> int:
    try:
        return open_child(parent_fd, component, display_path)
    except FileNotFoundError:
        try:
            os.mkdir(component, create_mode, dir_fd=parent_fd)
        except FileExistsError:
            pass
        return open_child(parent_fd, component, display_path)


if path_mode == "repository-default":
    parent_fd = walk_existing(repository_root)
    try:
        var_path = os.path.join(repository_root, "var")
        var_fd = create_and_open(parent_fd, "var", var_path, 0o755)
    finally:
        os.close(parent_fd)
    try:
        validate_trusted_parent(var_fd, var_path)
        final_fd = create_and_open(
            var_fd, "platform-router-state", os.path.join(var_path, "platform-router-state")
        )
    finally:
        os.close(var_fd)
else:
    parent_path, final_name = os.path.split(state_root)
    if not final_name:
        raise SystemExit(f"invalid platform-router state root: {state_root}")
    parent_fd = walk_existing(parent_path)
    try:
        final_fd = create_and_open(parent_fd, final_name, state_root)
    finally:
        os.close(parent_fd)

try:
    metadata = os.fstat(final_fd)
    if not stat.S_ISDIR(metadata.st_mode):
        raise SystemExit(f"platform-router state root is not a directory: {state_root}")
    # Descriptor-scoped changes cannot be redirected by a path swap. Children are never opened.
    os.fchown(final_fd, uid, gid)
    os.fchmod(final_fd, 0o770)
    os.fsync(final_fd)
finally:
    os.close(final_fd)

print(f"prepared {state_root} for Compose Web uid:gid {uid}:{gid} (mode 0770)")
PY
