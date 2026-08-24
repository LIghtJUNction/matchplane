#!/usr/bin/env bash

# Run curl into a file, then permit jq to see only a successful JSON response.
# Callers provide a workspace-owned temporary directory through HTTP_JSON_WORK_DIRECTORY.
http_json() {
  local output_file=$1
  shift
  local work_directory=${HTTP_JSON_WORK_DIRECTORY:?HTTP_JSON_WORK_DIRECTORY is required}
  local body_file="$work_directory/response.body"
  local metadata status content_type summary request_target
  request_target=${!#}

  if ! metadata=$(curl --silent --show-error \
      --output "$body_file" \
      --write-out '%{http_code}\t%{content_type}' "$@"); then
    echo "JSON probe transport failure for $request_target" >&2
    return 1
  fi

  IFS=$'\t' read -r status content_type <<<"$metadata"
  if [[ ! $status =~ ^2[0-9][0-9]$ ]]; then
    summary=$(head -c 200 "$body_file" | tr '\r\n\t' '   ')
    echo "JSON probe rejected $request_target: HTTP $status (${content_type:-no content-type}); body summary: ${summary:-<empty>}" >&2
    return 1
  fi
  if [[ ${content_type,,} != application/json* ]]; then
    summary=$(head -c 200 "$body_file" | tr '\r\n\t' '   ')
    echo "JSON probe rejected $request_target: content-type ${content_type:-<missing>} for HTTP $status; body summary: ${summary:-<empty>}" >&2
    return 1
  fi
  if [[ ! -s $body_file ]]; then
    echo "JSON probe received an empty body for $request_target (HTTP $status)" >&2
    return 1
  fi
  if ! jq empty "$body_file" >/dev/null 2>&1; then
    summary=$(head -c 200 "$body_file" | tr '\r\n\t' '   ')
    echo "JSON probe received invalid JSON for $request_target (HTTP $status); body summary: ${summary:-<empty>}" >&2
    return 1
  fi

  cp "$body_file" "$output_file"
}

http_json_pipe() {
  local output_file
  output_file=$(mktemp "$HTTP_JSON_WORK_DIRECTORY/pipe.XXXXXX")
  http_json "$output_file" "$@" || return
  cat "$output_file"
}
