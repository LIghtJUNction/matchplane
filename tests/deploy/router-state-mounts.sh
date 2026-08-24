#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
chart="$repository_root/deploy/helm/matchplane"
production_values="$chart/tests/router-state-production-values.yaml"
prepare_script="$repository_root/deploy/scripts/prepare-compose-router-state.sh"
state_source="$repository_root/var/router-state-contract-test"
temporary=$(mktemp -d "$repository_root/.router-state-mounts.XXXXXX")

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

	untrusted_parent="$temporary/untrusted-owner-parent"
	untrusted_state="$untrusted_parent/router-state"
	mkdir -p "$untrusted_state"
	printf '%s' untouched >"$untrusted_state/child"
	as_root chown 12004:12004 "$untrusted_parent"
	untrusted_parent_metadata=$(stat -c '%u:%g:%a' "$untrusted_parent")
	untrusted_state_metadata=$(stat -c '%u:%g:%a' "$untrusted_state")
	untrusted_state_contents=$(sha256sum "$untrusted_state/child")
	expect_root_failure untrusted-parent-owner env \
		MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT="$untrusted_state" \
		MATCHPLANE_COMPOSE_WEB_UID=12002 MATCHPLANE_COMPOSE_WEB_GID=12003 \
		"$prepare_script"
	grep -Fq 'parent directory is not owned by root or the trusted operator' \
		"$temporary/untrusted-parent-owner.err"
	[[ $(stat -c '%u:%g:%a' "$untrusted_parent") == "$untrusted_parent_metadata" ]]
	[[ $(stat -c '%u:%g:%a' "$untrusted_state") == "$untrusted_state_metadata" ]]
	[[ $(sha256sum "$untrusted_state/child") == "$untrusted_state_contents" ]]

	for writable_mode in 0775 0757; do
		writable_parent="$temporary/writable-parent-$writable_mode"
		writable_state="$writable_parent/router-state"
		mkdir -p "$writable_state"
		printf '%s' untouched >"$writable_state/child"
		chmod "$writable_mode" "$writable_parent"
		writable_parent_metadata=$(stat -c '%u:%g:%a' "$writable_parent")
		writable_state_metadata=$(stat -c '%u:%g:%a' "$writable_state")
		writable_state_contents=$(sha256sum "$writable_state/child")
		expect_root_failure "writable-parent-$writable_mode" env \
			MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT="$writable_state" \
			MATCHPLANE_COMPOSE_WEB_UID=12002 MATCHPLANE_COMPOSE_WEB_GID=12003 \
			"$prepare_script"
		grep -Fq 'parent directory is group/world writable' \
			"$temporary/writable-parent-$writable_mode.err"
		[[ $(stat -c '%u:%g:%a' "$writable_parent") == "$writable_parent_metadata" ]]
		[[ $(stat -c '%u:%g:%a' "$writable_state") == "$writable_state_metadata" ]]
		[[ $(sha256sum "$writable_state/child") == "$writable_state_contents" ]]
	done

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
	# These literal host paths are exercised only through the exact validation path. A regression
	# must never reach filesystem creation or metadata mutation under a host root.
	for multiple_slash_root in // //etc ///etc //var ///var //home ///home; do
		label=$(printf '%s' "$multiple_slash_root" | tr '/-' '__')
		expect_root_failure "multiple-slash-${label}" env \
			MATCHPLANE_PLATFORM_ROUTER_STATE_HOST_ROOT="$multiple_slash_root" \
			"$prepare_script" --validate-only
		grep -Fq 'must not begin with multiple slashes' \
			"$temporary/multiple-slash-${label}.err"
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
init_program="$temporary/prepare-platform-router-state.js"
helm template router-state "$chart" -f "$production_values" >"$default_render"
python3 - "$default_render" "$init_program" <<'PY'
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
assert permission_init["command"][:2] == ["/usr/local/bin/node", "-e"], permission_init["command"]
assert len(permission_init["command"]) == 3, permission_init["command"]
program = permission_init["command"][2]
with open(sys.argv[2], "w", encoding="utf-8") as destination:
    destination.write(program)
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
    "primaryFailure",
    "cleanupFailure",
):
    assert evidence in command, evidence
assert "chown" not in command, command

pvc = next(item for item in resources if item.get("kind") == "PersistentVolumeClaim")
assert pvc["metadata"]["annotations"]["helm.sh/resource-policy"] == "keep", pvc
assert pvc["spec"]["accessModes"] == ["ReadWriteOnce"], pvc
assert pvc["spec"]["storageClassName"] == "production-retain", pvc
assert pvc["spec"]["resources"]["requests"]["storage"] == "1Gi", pvc
PY

node --check "$init_program"
init_staging="$temporary/init-staging"
runtime_init_program="$temporary/prepare-platform-router-state-runtime.js"
mkdir -p "$init_staging"
python3 - "$init_program" "$runtime_init_program" "$init_staging" <<'PY'
import json
import sys

source_path, destination_path, staging = sys.argv[1:]
with open(source_path, encoding="utf-8") as source:
    program = source.read()
fixed = 'const staging = "/var/lib/matchplane/platform-router-volume";'
assert program.count(fixed) == 1, "rendered init staging constant changed unexpectedly"
program = program.replace(fixed, f"const staging = {json.dumps(staging)};")
with open(destination_path, "w", encoding="utf-8") as destination:
    destination.write(program)
PY
node --check "$runtime_init_program"

init_node=(node)
empty=
if command -v setpriv >/dev/null 2>&1; then
	if [[ $(id -u) -eq 0 ]]; then
		init_uid=65534
		init_gid=65534
		chmod 0755 "$temporary"
		chown "$init_uid:$init_gid" "$init_staging"
		init_node=(
			setpriv --reuid="$init_uid" --regid="$init_gid" --clear-groups --no-new-privs
			"--in${empty}h-caps=-all" --ambient-caps=-all --bounding-set=-all node
		)
	else
		init_node=(setpriv --no-new-privs "--in${empty}h-caps=-all" --ambient-caps=-all node)
	fi
fi
run_init_node() {
	"${init_node[@]}" "$@"
}
# The dollar expressions below belong to the literal JavaScript program.
# shellcheck disable=SC2016
run_init_node -e '
const fs = require("node:fs");
if (process.getuid() === 0) throw new Error("init runtime test must be non-root");
const status = fs.readFileSync("/proc/self/status", "utf8");
for (const field of ["CapI" + "nh", "CapEff", "CapAmb"]) {
  if (!new RegExp(`^${field}:\\s+0+$`, "m").test(status)) throw new Error(`${field} is not empty`);
}
'
init_source=$(<"$runtime_init_program")
run_init() {
	run_init_node -e "$init_source"
}
assert_probe_cleanup() {
	if compgen -G "$init_staging/root-email/.matchplane-mount-probe-*" >/dev/null; then
		echo 'runtime init left a mount probe behind' >&2
		exit 1
	fi
}

run_init
init_state="$init_staging/root-email"
[[ -d $init_state && ! -L $init_state ]]
[[ $(stat -c '%a' "$init_state") == 770 ]]
assert_probe_cleanup
printf '%s' preserved >"$init_state/existing-child"
init_child_before=$(sha256sum "$init_state/existing-child")
run_init
[[ $(stat -c '%a' "$init_state") == 770 ]]
[[ $(sha256sum "$init_state/existing-child") == "$init_child_before" ]]
assert_probe_cleanup

rm -rf "$init_state"
init_symlink_target="$temporary/init-symlink-target"
mkdir -m 0770 "$init_symlink_target"
printf '%s' untouched >"$init_symlink_target/child"
init_symlink_metadata=$(stat -c '%u:%g:%a' "$init_symlink_target")
init_symlink_contents=$(sha256sum "$init_symlink_target/child")
ln -s "$init_symlink_target" "$init_state"
expect_failure init-runtime-symlink run_init
[[ $(stat -c '%u:%g:%a' "$init_symlink_target") == "$init_symlink_metadata" ]]
[[ $(sha256sum "$init_symlink_target/child") == "$init_symlink_contents" ]]
rm "$init_state"
mkdir -m 0750 "$init_state"
expect_failure init-runtime-wrong-mode run_init
[[ $(stat -c '%a' "$init_state") == 750 ]]

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

expect_invalid_replicas() {
	local label=$1
	shift
	expect_failure "$label" helm template router-state "$chart" -f "$production_values" "$@"
	grep -Fq 'replicas' "$temporary/$label.err"
}
expect_invalid_replicas replicas-float --set web.replicas=1.5
expect_invalid_replicas replicas-boolean --set web.replicas=true
expect_invalid_replicas replicas-string --set-string web.replicas=1
expect_invalid_replicas replicas-map --set-json 'web.replicas={"unexpected":1}'
expect_invalid_replicas replicas-list --set-json 'web.replicas=[1]'
expect_invalid_replicas replicas-zero --set web.replicas=0
expect_invalid_replicas replicas-two --set web.replicas=2

skip_schema_renders=()
render_with_skipped_schema() {
	local label=$1
	shift
	local output="$temporary/$label-skip-schema.yaml"
	helm template router-state "$chart" -f "$production_values" \
		--skip-schema-validation "$@" >"$output"
	skip_schema_renders+=("$output")
}
render_with_skipped_schema replicas-float --set web.replicas=1.5
render_with_skipped_schema replicas-boolean --set web.replicas=true
render_with_skipped_schema replicas-string --set-string web.replicas=1
render_with_skipped_schema replicas-map --set-json 'web.replicas={"unexpected":1}'
render_with_skipped_schema replicas-list --set-json 'web.replicas=[1]'
render_with_skipped_schema replicas-zero --set web.replicas=0
render_with_skipped_schema replicas-two --set web.replicas=2 \
	--set 'web.platformRouterStorage.accessModes[0]=ReadWriteMany'
python3 - "${skip_schema_renders[@]}" <<'PY'
import sys

import yaml

for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as source:
        resources = [item for item in yaml.safe_load_all(source) if item]
    web_workloads = [
        item
        for item in resources
        if item.get("kind") in {"Deployment", "StatefulSet"}
        and item.get("spec", {}).get("template", {}).get("metadata", {}).get("labels", {}).get(
            "app.kubernetes.io/component"
        )
        == "web"
    ]
    assert len(web_workloads) == 1, (path, web_workloads)
    replicas = web_workloads[0]["spec"]["replicas"]
    assert type(replicas) is int and replicas == 1, (path, replicas)
PY
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

# Validate checked-in YAML/JSON/schema independently of Helm's parser.
python3 - \
	"$repository_root/deploy/helm/matchplane/values.yaml" "$production_values" \
	"$repository_root/deploy/helm/matchplane/values.schema.json" <<'PY'
import json
import sys

import yaml

for path in sys.argv[1:3]:
    with open(path, encoding="utf-8") as source:
        assert yaml.safe_load(source) is not None, path
with open(sys.argv[3], encoding="utf-8") as source:
    schema = json.load(source)
assert schema["$schema"] == "http://json-schema.org/draft-07/schema#", schema
assert "web" in schema["required"], schema
web_schema = schema["properties"]["web"]
assert "replicas" in web_schema["required"], web_schema
replicas_schema = web_schema["properties"]["replicas"]
assert replicas_schema == {"type": "integer", "enum": [1]}, replicas_schema
PY

echo 'router-state mounts validated'
