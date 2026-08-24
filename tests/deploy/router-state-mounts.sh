#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
chart="$repository_root/deploy/helm/matchplane"
production_values="$chart/tests/router-state-production-values.yaml"
prepare_script="$repository_root/deploy/scripts/prepare-compose-router-state.sh"
state_source="$repository_root/var/router-state-contract-test"
temporary=$(mktemp -d)

as_root() {
	if [[ $(id -u) -eq 0 ]]; then
		"$@"
	elif sudo -n true >/dev/null 2>&1; then
		sudo -n "$@"
	else
		return 77
	fi
}

cleanup() {
	if ! as_root rm -rf "$temporary"; then
		echo "warning: could not remove router-state test directory $temporary" >&2
	fi
}
trap cleanup EXIT

expect_failure() {
	local label=$1
	shift
	if "$@" >"$temporary/$label.out" 2>"$temporary/$label.err"; then
		echo "$label unexpectedly succeeded" >&2
		exit 1
	fi
}

expect_root_failure() {
	local label=$1
	shift
	if as_root "$@" >"$temporary/$label.out" 2>"$temporary/$label.err"; then
		echo "$label unexpectedly succeeded" >&2
		exit 1
	fi
}

# Compose must expose exactly one Web-only read-write bind at the canonical path.
compose_json="$temporary/compose.json"
default_compose_json="$temporary/compose-default.json"
docker compose --env-file "$repository_root/.env.example" \
	-f "$repository_root/deploy/compose/compose.yaml" config --format json >"$default_compose_json"
MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT="$state_source" \
	docker compose --env-file "$repository_root/.env.example" \
	-f "$repository_root/deploy/compose/compose.yaml" config --format json >"$compose_json"
python3 - \
	"$default_compose_json" "$repository_root/var/platform-router-state" \
	"$compose_json" "$state_source" <<'PY'
import json
import os
import sys

target = "/etc/matchplane/secrets/root-email"
for model_path, source_path in zip(sys.argv[1::2], sys.argv[2::2], strict=True):
    with open(model_path, encoding="utf-8") as model_file:
        model = json.load(model_file)
    expected_source = os.path.realpath(source_path)
    matched = []
    for service_name, service in model["services"].items():
        for mount in service.get("volumes", []):
            if mount.get("target") == target:
                matched.append((service_name, mount))
    assert len(matched) == 1, matched
    service_name, mount = matched[0]
    assert service_name == "web", matched
    assert mount.get("type") == "bind", mount
    assert os.path.realpath(mount.get("source", "")) == expected_source, mount
    assert mount.get("read_only", False) is False, mount
PY

# Exercise descriptor/no-follow Compose preparation. The fixture copy gives the default path an
# isolated physical repository root rather than touching this worktree's durable directory.
if as_root true >/dev/null 2>&1; then
	fixture_repository="$temporary/default-repository"
	mkdir -p "$fixture_repository/deploy/scripts"
	cp "$prepare_script" "$fixture_repository/deploy/scripts/prepare-compose-router-state.sh"
	chmod 0755 "$fixture_repository/deploy/scripts/prepare-compose-router-state.sh"
	test_uid=$(id -u)
	test_gid=$(id -g)
	if [[ $test_uid -eq 0 ]]; then
		test_uid=12001
		test_gid=12001
	fi
	as_root env MATCHPLANE_COMPOSE_WEB_UID="$test_uid" MATCHPLANE_COMPOSE_WEB_GID="$test_gid" \
		"$fixture_repository/deploy/scripts/prepare-compose-router-state.sh"
	default_state="$fixture_repository/var/platform-router-state"
	as_root test -d "$default_state"
	as_root test ! -L "$default_state"
	[[ $(as_root stat -c '%u:%g:%a' "$default_state") == "$test_uid:$test_gid:770" ]]
	printf '%s' preserved | as_root tee "$default_state/child" >/dev/null
	before_child=$(as_root sha256sum "$default_state/child")
	as_root env MATCHPLANE_COMPOSE_WEB_UID="$test_uid" MATCHPLANE_COMPOSE_WEB_GID="$test_gid" \
		"$fixture_repository/deploy/scripts/prepare-compose-router-state.sh"
	[[ $(as_root sha256sum "$default_state/child") == "$before_child" ]]

	custom_parent="$temporary/custom-parent"
	mkdir -p "$custom_parent"
	custom_state="$custom_parent/router-state"
	as_root env MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT="$custom_state" \
		MATCHPLANE_COMPOSE_WEB_UID="$test_uid" MATCHPLANE_COMPOSE_WEB_GID="$test_gid" \
		"$prepare_script"
	[[ $(stat -c '%u:%g:%a' "$custom_state") == "$test_uid:$test_gid:770" ]]

	final_target="$temporary/final-symlink-target"
	mkdir "$final_target"
	printf '%s' untouched >"$final_target/child"
	final_metadata=$(stat -c '%u:%g:%a' "$final_target")
	final_contents=$(sha256sum "$final_target/child")
	ln -s "$final_target" "$temporary/final-symlink"
	expect_root_failure final-symlink env \
		MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT="$temporary/final-symlink" \
		MATCHPLANE_COMPOSE_WEB_UID=12002 MATCHPLANE_COMPOSE_WEB_GID=12003 "$prepare_script"
	[[ $(stat -c '%u:%g:%a' "$final_target") == "$final_metadata" ]]
	[[ $(sha256sum "$final_target/child") == "$final_contents" ]]

	intermediate_target="$temporary/intermediate-target"
	mkdir -p "$intermediate_target/router-state" "$temporary/intermediate-parent"
	printf '%s' untouched >"$intermediate_target/router-state/child"
	intermediate_metadata=$(stat -c '%u:%g:%a' "$intermediate_target/router-state")
	intermediate_contents=$(sha256sum "$intermediate_target/router-state/child")
	ln -s "$intermediate_target" "$temporary/intermediate-parent/link"
	expect_root_failure intermediate-symlink env \
		MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT="$temporary/intermediate-parent/link/router-state" \
		MATCHPLANE_COMPOSE_WEB_UID=12002 MATCHPLANE_COMPOSE_WEB_GID=12003 "$prepare_script"
	[[ $(stat -c '%u:%g:%a' "$intermediate_target/router-state") == "$intermediate_metadata" ]]
	[[ $(sha256sum "$intermediate_target/router-state/child") == "$intermediate_contents" ]]

	for unsafe_root in / /etc /var /usr /home /srv; do
		label=$(printf '%s' "$unsafe_root" | tr '/-' '__')
		expect_root_failure "sensitive-root-${label}" env \
			MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT="$unsafe_root" "$prepare_script"
	done
	expect_root_failure relative-override env \
		MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT=relative/router-state "$prepare_script"
	expect_root_failure missing-external-parent env \
		MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT="$temporary/missing-parent/router-state" "$prepare_script"
	[[ ! -e $temporary/missing-parent ]]
	expect_root_failure invalid-uid env \
		MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT="$temporary/invalid-uid" \
		MATCHPLANE_COMPOSE_WEB_UID=not-a-uid "$prepare_script"
	expect_root_failure invalid-gid env \
		MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT="$temporary/invalid-gid" \
		MATCHPLANE_COMPOSE_WEB_GID=-1 "$prepare_script"
	expect_root_failure out-of-range-uid env \
		MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT="$temporary/out-of-range" \
		MATCHPLANE_COMPOSE_WEB_UID=4294967295 "$prepare_script"

	if [[ $(id -u) -ne 0 ]]; then
		expect_failure nonroot env \
			MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT="$temporary/nonroot-state" "$prepare_script"
	elif command -v setpriv >/dev/null 2>&1; then
		chmod 0755 "$temporary" "$fixture_repository" "$fixture_repository/deploy" \
			"$fixture_repository/deploy/scripts"
		expect_failure nonroot setpriv --reuid=65534 --regid=65534 --clear-groups env \
			MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT="$temporary/nonroot-state" \
			"$fixture_repository/deploy/scripts/prepare-compose-router-state.sh"
	fi
else
	echo 'warning: skipping root-only Compose path tests (no root or passwordless sudo)' >&2
fi

helm lint "$chart" -f "$production_values"
default_render="$temporary/default.yaml"
helm template router-state "$chart" -f "$production_values" >"$default_render"
python3 - "$default_render" <<'PY'
import sys

import yaml

with open(sys.argv[1], encoding="utf-8") as rendered_file:
    resources = [item for item in yaml.safe_load_all(rendered_file) if item]
target = "/etc/matchplane/secrets/root-email"
staging = "/var/lib/matchplane/platform-router-volume"
workloads = [item for item in resources if item.get("kind") in {"Deployment", "StatefulSet"}]
web = next(item for item in workloads if item["metadata"]["name"].endswith("-web"))
assert web["spec"]["replicas"] == 1, web["spec"]
assert web["spec"]["strategy"] == {"type": "Recreate"}, web["spec"].get("strategy")

canonical_mounts = []
staging_mounts = []
for workload in workloads:
    pod = workload["spec"]["template"]["spec"]
    for category in ("containers", "initContainers"):
        for container in pod.get(category, []):
            for mount in container.get("volumeMounts", []):
                record = (workload, category, container, mount)
                if mount.get("mountPath") == target:
                    canonical_mounts.append(record)
                if mount.get("mountPath") == staging:
                    staging_mounts.append(record)
assert len(canonical_mounts) == 1, canonical_mounts
workload, category, container, mount = canonical_mounts[0]
assert workload is web and category == "containers" and container["name"] == "web", canonical_mounts
assert mount["name"] == "platform-router-state", mount
assert mount["subPath"] == "root-email", mount
assert mount.get("readOnly") is False, mount
assert len(staging_mounts) == 1, staging_mounts
workload, category, container, mount = staging_mounts[0]
assert workload is web and category == "initContainers", staging_mounts
assert container["name"] == "prepare-platform-router-state", container
assert mount["name"] == "platform-router-state" and "subPath" not in mount, mount
assert mount.get("readOnly") is False, mount

web_spec = web["spec"]["template"]["spec"]
volume = next(item for item in web_spec["volumes"] if item["name"] == "platform-router-state")
assert set(volume) == {"name", "persistentVolumeClaim"}, volume
assert set(volume["persistentVolumeClaim"]) == {"claimName"}, volume
assert not any(
    item.get("name") == "platform-router-state"
    for workload in workloads
    if workload is not web
    for item in workload["spec"]["template"]["spec"].get("volumes", [])
), "platform-router state leaked to another workload"

web_container = next(item for item in web_spec["containers"] if item["name"] == "web")
assert web_container["securityContext"]["readOnlyRootFilesystem"] is True
permission_init = next(
    item for item in web_spec["initContainers"] if item["name"] == "prepare-platform-router-state"
)
security = permission_init["securityContext"]
assert security["runAsNonRoot"] is True, security
assert security["runAsUser"] == web_spec["securityContext"]["runAsUser"], security
assert security["runAsGroup"] == web_spec["securityContext"]["runAsGroup"], security
assert security["allowPrivilegeEscalation"] is False, security
assert security["readOnlyRootFilesystem"] is True, security
assert security["capabilities"] == {"drop": ["ALL"]}, security
command = "\n".join(permission_init["command"])
for evidence in (
    "isSymbolicLink",
    "isDirectory",
    "mode must be exactly 0770",
    "R_OK",
    "W_OK",
    "X_OK",
    'openSync(pending, "wx"',
    "fsyncSync(probe)",
    "renameSync",
    "O_DIRECTORY",
    "fsyncSync(directory)",
    "unlinkSync",
):
    assert evidence in command, evidence
assert "chown" not in command, command

pvc = next(item for item in resources if item.get("kind") == "PersistentVolumeClaim")
assert pvc["metadata"]["annotations"]["helm.sh/resource-policy"] == "keep", pvc
assert pvc["spec"]["accessModes"] == ["ReadWriteOnce"], pvc
assert pvc["spec"]["storageClassName"] == "production-retain", pvc
assert pvc["spec"]["resources"]["requests"]["storage"] == "1Gi", pvc
PY

existing_render="$temporary/existing.yaml"
helm template router-state "$chart" -f "$production_values" \
	--set web.platformRouterStorage.existingClaim=router-state-existing \
	--set web.platformRouterStorage.storageClass= \
	--set-json 'web.platformRouterStorage.accessModes=[]' >"$existing_render"
python3 - "$existing_render" <<'PY'
import sys
import yaml
with open(sys.argv[1], encoding="utf-8") as source:
    resources = [item for item in yaml.safe_load_all(source) if item]
assert not any(item.get("kind") == "PersistentVolumeClaim" for item in resources), resources
web = next(item for item in resources if item.get("kind") == "Deployment" and item["metadata"]["name"].endswith("-web"))
volume = next(item for item in web["spec"]["template"]["spec"]["volumes"] if item["name"] == "platform-router-state")
assert volume["persistentVolumeClaim"]["claimName"] == "router-state-existing", volume
PY

helm template router-state "$chart" -f "$production_values" \
	--set runtime.environment=development \
	--set web.platformRouterStorage.storageClass= >"$temporary/nonproduction-default-class.yaml"

expect_failure replicas-two helm template router-state "$chart" -f "$production_values" \
	--set web.replicas=2 \
	--set 'web.platformRouterStorage.accessModes[0]=ReadWriteMany'
grep -Fq 'web.replicas must be exactly 1' "$temporary/replicas-two.err"
expect_failure disabled-storage helm template router-state "$chart" -f "$production_values" \
	--set web.platformRouterStorage.enabled=false
grep -Fq 'must be true while the Web deployment is enabled' "$temporary/disabled-storage.err"
expect_failure missing-storage helm template router-state "$chart" -f "$production_values" \
	--set-json web.platformRouterStorage=null
grep -Fq 'web.platformRouterStorage is required' "$temporary/missing-storage.err"
expect_failure missing-size helm template router-state "$chart" -f "$production_values" \
	--set web.platformRouterStorage.size=
grep -Fq 'size is required when existingClaim is empty' "$temporary/missing-size.err"
expect_failure production-default-class helm template router-state "$chart" -f "$production_values" \
	--set web.platformRouterStorage.storageClass=
grep -Fq 'storageClass is required in production when existingClaim is empty' \
	"$temporary/production-default-class.err"

# Validate checked-in YAML independently of Helm's parser.
python3 - "$repository_root/deploy/helm/matchplane/values.yaml" "$production_values" <<'PY'
import sys
import yaml
for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as source:
        assert yaml.safe_load(source) is not None, path
PY

echo 'router-state mounts validated'
