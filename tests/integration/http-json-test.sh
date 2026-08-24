#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
test_root=${MATCHPLANE_SMOKE_TMPDIR:-$repository_root/.scratch/ci-smoke}
mkdir -p "$test_root"
work_directory=$(mktemp -d "$test_root/http-json-test.XXXXXX")
port_file="$work_directory/port"
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n ${server_pid:-} ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null
  fi
  rm -rf "$work_directory"
  exit "$status"
}
trap cleanup EXIT

python3 - "$port_file" <<'PY' &
import http.server
import pathlib
import sys

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        responses = {
            "/ok": (200, "application/json", b'{"status":"ok"}'),
            "/array": (200, "application/json", b'["ok"]'),
            "/object": (200, "application/json", b'{"status":"ok"}'),
            "/invalid": (200, "application/json", b'{invalid'),
            "/not-found": (404, "text/html", b"<html>not found</html>"),
            "/unavailable": (503, "application/json", b'{"error":"unavailable"}'),
            "/empty": (200, "application/json", b""),
        }
        status, content_type, body = responses[self.path]
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass

server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
pathlib.Path(sys.argv[1]).write_text(str(server.server_port))
server.serve_forever()
PY
server_pid=$!
for _ in $(seq 1 50); do
  [[ -s "$port_file" ]] && break
  sleep 0.1
done
port=$(<"$port_file")

# shellcheck disable=SC1091
source "$repository_root/tests/integration/http-json.sh"
HTTP_JSON_WORK_DIRECTORY="$work_directory"
export HTTP_JSON_WORK_DIRECTORY

http_json "$work_directory/ok.json" "http://127.0.0.1:$port/ok"
jq -e '.status == "ok"' "$work_directory/ok.json" >/dev/null
http_json "$work_directory/ok-after-header.json" "http://127.0.0.1:$port/ok" \
  --header 'x-test-header: URL comes before headers'
jq -e '.status == "ok"' "$work_directory/ok-after-header.json" >/dev/null
http_json "$work_directory/array.json" "http://127.0.0.1:$port/array"
jq -e 'type == "array" and .[0] == "ok"' "$work_directory/array.json" >/dev/null
http_json_pipe "http://127.0.0.1:$port/object" \
  --header 'x-test-header: URL comes before headers' \
  | jq -e 'type == "object" and .status == "ok"' >/dev/null

for path in invalid not-found unavailable empty; do
  if http_json "$work_directory/$path.json" "http://127.0.0.1:$port/$path"; then
    echo "expected JSON probe to reject $path" >&2
    exit 1
  fi
done

echo 'HTTP JSON probe tests passed'
