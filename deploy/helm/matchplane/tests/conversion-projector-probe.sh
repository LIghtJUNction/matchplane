#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
chart="$repository_root/deploy/helm/matchplane"
digest="sha256:$(printf '0%.0s' {1..64})"
rendered=$(mktemp)
error_output=$(mktemp)
trap 'rm -f "$rendered" "$error_output"' EXIT

base_args=(
  matchplane "$chart"
  --show-only templates/deployments.yaml
  --set-string "image.digest=$digest"
  --set-string "web.image.digest=$digest"
  --set-string runtime.environment=development
  --set-string runtime.nodeId=018f0f57-7b2c-7a2d-8c51-2f758b03d1e0
  --set-string runtime.existingSecret=matchplane-runtime
  --set-string runtime.existingKafkaTlsSecret=matchplane-kafka-tls
  --set-string runtime.existingGatewaySecret=matchplane-gateway
  --set-string runtime.existingPaymentSecret=matchplane-payment
  --set-string runtime.existingTlsSecret=matchplane-tls
  --set-string runtime.existingWebSecret=matchplane-web
  --set-string web.betterAuthUrl=https://matchplane.test
  --set subplatformBuilder.enabled=false
  --set conversionProjector.enabled=true
)

helm template "${base_args[@]}" --set conversionProjector.batchSize=1 >"$rendered"
python3 - "$rendered" <<'PY'
import re
import sys
from pathlib import Path

rendered = Path(sys.argv[1]).read_text(encoding="utf-8")
documents = re.split(r"\n---\s*\n", rendered)
projectors = [
    document
    for document in documents
    if "kind: Deployment" in document
    and "app.kubernetes.io/component: conversion-projector" in document
]
assert len(projectors) == 1, f"expected one conversion projector deployment, got {len(projectors)}"
projector = projectors[0]
assert re.search(
    r"readinessProbe:\s+httpGet:\s+path: /health/ready\s+port: http",
    projector,
), "conversion projector readiness probe must call /health/ready over HTTP"
assert re.search(
    r"livenessProbe:\s+httpGet:\s+path: /health/live\s+port: http",
    projector,
), "conversion projector liveness probe must call /health/live over HTTP"
assert "MATCHPLANE_VALKEY_URL" not in projector, (
    "database-only conversion projector must not receive MATCHPLANE_VALKEY_URL"
)
assert "valkey-url" not in projector, (
    "database-only conversion projector must not reference the valkey-url secret key"
)
PY

if helm template "${base_args[@]}" --set conversionProjector.batchSize=2 \
  >/dev/null 2>"$error_output"; then
  echo 'Helm accepted conversionProjector.batchSize other than 1' >&2
  exit 1
fi
grep -Fq 'conversionProjector.batchSize must be exactly 1' "$error_output"
