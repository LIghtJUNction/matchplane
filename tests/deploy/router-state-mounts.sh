#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
chart="$repository_root/deploy/helm/matchplane"
production_values="$chart/tests/router-state-production-values.yaml"
state_source="$repository_root/var/router-state-contract-test"
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT

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

helm lint "$chart" -f "$production_values"
default_render="$temporary/default.yaml"
helm template router-state "$chart" -f "$production_values" >"$default_render"
python3 - "$default_render" <<'PY'
import sys

import yaml

with open(sys.argv[1], encoding="utf-8") as rendered_file:
    resources = [item for item in yaml.safe_load_all(rendered_file) if item]
target = "/etc/matchplane/secrets/root-email"
workloads = [item for item in resources if item.get("kind") in {"Deployment", "StatefulSet"}]
web = next(item for item in workloads if item["metadata"]["name"].endswith("-web"))
for workload in workloads:
    template = workload["spec"]["template"]["spec"]
    mounts = [
        mount
        for container in template.get("containers", []) + template.get("initContainers", [])
        for mount in container.get("volumeMounts", [])
        if mount.get("mountPath") == target
    ]
    assert len(mounts) == (2 if workload is web else 0), (workload["metadata"]["name"], mounts)
    assert all(mount["name"] == "platform-router-state" for mount in mounts), mounts
    assert all(mount.get("readOnly") is False for mount in mounts), mounts
web_spec = web["spec"]["template"]["spec"]
volume = next(item for item in web_spec["volumes"] if item["name"] == "platform-router-state")
assert set(volume) == {"name", "persistentVolumeClaim"}, volume
assert "claimName" in volume["persistentVolumeClaim"], volume
web_container = next(item for item in web_spec["containers"] if item["name"] == "web")
assert web_container["securityContext"]["readOnlyRootFilesystem"] is True
permission_init = next(
    item for item in web_spec["initContainers"] if item["name"] == "prepare-platform-router-state"
)
assert permission_init["securityContext"].get("privileged", False) is False
assert permission_init["securityContext"]["allowPrivilegeEscalation"] is False
pvc = next(item for item in resources if item.get("kind") == "PersistentVolumeClaim")
assert "ReadWriteMany" in pvc["spec"]["accessModes"], pvc
PY

existing_render="$temporary/existing.yaml"
helm template router-state "$chart" -f "$production_values" \
	--set web.platformRouterStorage.existingClaim=router-state-existing >"$existing_render"
if grep -Fq '# Source: matchplane/templates/platform-router-pvc.yaml' "$existing_render"; then
	echo 'existing-claim mode unexpectedly rendered a chart-owned PVC' >&2
	exit 1
fi
grep -Fq 'claimName: router-state-existing' "$existing_render"

helm template router-state "$chart" -f "$production_values" \
	--set web.replicas=3 >"$temporary/multi-rwx.yaml"
helm template router-state "$chart" -f "$production_values" \
	--set web.replicas=1 \
	--set 'web.platformRouterStorage.accessModes[0]=ReadWriteOnce' \
	>"$temporary/single-rwo.yaml"
if helm template router-state "$chart" -f "$production_values" \
	--set 'web.platformRouterStorage.accessModes[0]=ReadWriteOnce' \
	>"$temporary/multi-rwo.out" 2>"$temporary/multi-rwo.err"; then
	echo 'replicated Web unexpectedly accepted non-RWX router storage' >&2
	exit 1
fi
grep -Fq 'must include ReadWriteMany' "$temporary/multi-rwo.err"
if helm template router-state "$chart" -f "$production_values" \
	--set web.platformRouterStorage.enabled=false \
	>"$temporary/disabled.out" 2>"$temporary/disabled.err"; then
	echo 'Web unexpectedly accepted disabled router storage' >&2
	exit 1
fi
grep -Fq 'must be true while the Web deployment is enabled' "$temporary/disabled.err"
if helm template router-state "$chart" -f "$production_values" \
	--set-json web.platformRouterStorage=null \
	>"$temporary/missing-storage.out" 2>"$temporary/missing-storage.err"; then
	echo 'Web unexpectedly accepted missing router storage' >&2
	exit 1
fi
grep -Fq 'web.platformRouterStorage is required' "$temporary/missing-storage.err"
if helm template router-state "$chart" -f "$production_values" \
	--set web.platformRouterStorage.size= \
	>"$temporary/missing-size.out" 2>"$temporary/missing-size.err"; then
	echo 'chart-owned router storage unexpectedly accepted a missing size' >&2
	exit 1
fi
grep -Fq 'size is required when existingClaim is empty' "$temporary/missing-size.err"

echo 'router-state mounts validated'
