#!/usr/bin/env bash

# Diagnostics are intentionally process-local: callers that need them (wait_for) invoke
# http_json directly, never in a pipeline. A pipeline/subshell must not read its updates.
HTTP_JSON_LAST_STATUS=unknown
HTTP_JSON_LAST_CONTENT_TYPE=unknown

# Capture and validate one response. status_policy is either 2xx or exact.
_http_json_capture_validate() {
  local output_file=$1
  local request_target=$2
  local status_policy=$3
  local expected_status=$4
  shift 4
  local work_directory=${HTTP_JSON_WORK_DIRECTORY:?HTTP_JSON_WORK_DIRECTORY is required}
  local body_file metadata status content_type

  body_file=$(mktemp "$work_directory/response.XXXXXX")
  if ! metadata=$(curl --silent --show-error \
    --output "$body_file" \
    --write-out '%{http_code}\t%{content_type}' "$@" "$request_target"); then
    IFS=$'\t' read -r status content_type <<<"$metadata"
    HTTP_JSON_LAST_STATUS=${status:-unknown}
    HTTP_JSON_LAST_CONTENT_TYPE=${content_type:-unknown}
    echo "JSON probe transport failure for $request_target (HTTP ${HTTP_JSON_LAST_STATUS}; content-type ${HTTP_JSON_LAST_CONTENT_TYPE})" >&2
    rm -f "$body_file"
    return 1
  fi

  IFS=$'\t' read -r status content_type <<<"$metadata"
  HTTP_JSON_LAST_STATUS=${status:-unknown}
  HTTP_JSON_LAST_CONTENT_TYPE=${content_type:-missing}
  if [[ $status_policy == 2xx && ! $status =~ ^2[0-9][0-9]$ ]]; then
    echo "JSON probe rejected $request_target: HTTP $status (content-type ${content_type:-missing})" >&2
    rm -f "$body_file"
    return 1
  fi
  if [[ $status_policy == exact && $status != "$expected_status" ]]; then
    echo "JSON probe rejected $request_target: expected HTTP $expected_status, got $status (content-type ${content_type:-missing})" >&2
    rm -f "$body_file"
    return 1
  fi
  if [[ ${content_type,,} != application/json* ]]; then
    echo "JSON probe rejected $request_target: HTTP $status (content-type ${content_type:-missing})" >&2
    rm -f "$body_file"
    return 1
  fi
  if [[ ! -s $body_file ]]; then
    echo "JSON probe rejected $request_target: HTTP $status (content-type ${content_type:-missing}; empty body)" >&2
    rm -f "$body_file"
    return 1
  fi
  if ! jq empty "$body_file" >/dev/null 2>&1; then
    echo "JSON probe rejected $request_target: HTTP $status (content-type ${content_type:-missing}; invalid JSON)" >&2
    rm -f "$body_file"
    return 1
  fi

  if ! mv -f "$body_file" "$output_file"; then
    rm -f "$body_file"
    return 1
  fi
}

# API: http_json OUTPUT_FILE URL [curl options]. Normal probes require a 2xx JSON response.
# Keeping URL explicit prevents option parsing mistakes and means callers never need eval.
http_json() {
  local output_file=$1
  local request_target=$2
  shift 2
  _http_json_capture_validate "$output_file" "$request_target" 2xx '' "$@"
}

# Validate JSON with a deliberately expected status (including non-2xx errors).
# This is only for assertions such as authorization failures.
http_json_expect_status() {
  local expected_status=$1
  local output_file=$2
  local request_target=$3
  shift 3
  _http_json_capture_validate "$output_file" "$request_target" exact "$expected_status" "$@"
}

http_json_pipe() {
  local request_target=$1
  shift
  local output_file status
  output_file=$(mktemp "$HTTP_JSON_WORK_DIRECTORY/pipe.XXXXXX")
  if ! http_json "$output_file" "$request_target" "$@"; then
    rm -f "$output_file"
    return 1
  fi
  cat "$output_file"
  status=$?
  rm -f "$output_file"
  return "$status"
}
