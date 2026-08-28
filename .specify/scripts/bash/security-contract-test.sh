#!/usr/bin/env bash

set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    cat <<'EOF'
Usage: security-contract-test.sh

Run Speckit Bash path-containment regression tests in a temporary pseudo-repository.
EOF
    exit 0
fi
if [[ $# -ne 0 ]]; then
    echo "ERROR: This test accepts no arguments" >&2
    exit 1
fi

SCRIPT_DIR="$(CDPATH="" cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TEST_TMP="$(mktemp -d)"
trap 'rm -rf -- "$TEST_TMP"' EXIT HUP INT TERM

TEST_REPO="$TEST_TMP/repo"
OUTSIDE="$TEST_TMP/outside"
COPIED_SCRIPTS="$TEST_REPO/.specify/scripts/bash"
mkdir -p "$COPIED_SCRIPTS" "$TEST_REPO/.specify/templates" "$TEST_REPO/specs" "$OUTSIDE"
cp "$SCRIPT_DIR"/*.sh "$COPIED_SCRIPTS/"
printf '%s\n' '# Plan template' >"$TEST_REPO/.specify/templates/plan-template.md"
printf '%s\n' '# Tasks template' >"$TEST_REPO/.specify/templates/tasks-template.md"

fail() {
    echo "security-contract-test: FAIL: $1" >&2
    exit 1
}

expect_failure() {
    local description="$1"
    shift
    if "$@" >"$TEST_TMP/command.stdout" 2>"$TEST_TMP/command.stderr"; then
        fail "$description was accepted"
    fi
}

assert_feature_dir() {
    local expected="$1"
    shift
    local output
    output=$("$@") || fail "valid feature directory was rejected"
    [[ "$output" == *"\"FEATURE_DIR\":\"$expected\""* ]] || fail "canonical feature directory was not returned"
}

RELATIVE_FEATURE="$TEST_REPO/specs/001-relative"
assert_feature_dir "$RELATIVE_FEATURE" \
    env SPECIFY_INIT_DIR="$TEST_REPO" SPECIFY_FEATURE_DIRECTORY="specs/001-relative" \
    "$COPIED_SCRIPTS/check-prerequisites.sh" --paths-only --json
env SPECIFY_INIT_DIR="$TEST_REPO" SPECIFY_FEATURE_DIRECTORY="specs/001-relative" \
    "$COPIED_SCRIPTS/setup-plan.sh" >/dev/null
[[ "$(<"$RELATIVE_FEATURE/plan.md")" == "# Plan template" ]] || fail "normal in-repository template regressed"

ABSOLUTE_FEATURE="$TEST_REPO/specs/002-absolute"
assert_feature_dir "$ABSOLUTE_FEATURE" \
    env SPECIFY_INIT_DIR="$TEST_REPO" SPECIFY_FEATURE_DIRECTORY="$ABSOLUTE_FEATURE" \
    "$COPIED_SCRIPTS/check-prerequisites.sh" --paths-only --json

JSON_FEATURE="$TEST_REPO/specs/003-json"
printf '{"feature_dir":"%s"}\n' "$JSON_FEATURE" >"$TEST_REPO/.specify/feature.json"
assert_feature_dir "$JSON_FEATURE" \
    env -u SPECIFY_FEATURE_DIRECTORY SPECIFY_INIT_DIR="$TEST_REPO" \
    "$COPIED_SCRIPTS/check-prerequisites.sh" --paths-only --json

rm -f "$TEST_REPO/.specify/feature.json"
expect_failure "relative traversal" \
    env SPECIFY_INIT_DIR="$TEST_REPO" SPECIFY_FEATURE_DIRECTORY="../../tmp-escape" \
    "$COPIED_SCRIPTS/setup-plan.sh"

expect_failure "absolute path outside specs" \
    env SPECIFY_INIT_DIR="$TEST_REPO" SPECIFY_FEATURE_DIRECTORY="/etc" \
    "$COPIED_SCRIPTS/setup-plan.sh"

printf '%s\n' '{"feature_directory":"../../json-escape"}' >"$TEST_REPO/.specify/feature.json"
expect_failure "feature.json traversal" \
    env -u SPECIFY_FEATURE_DIRECTORY SPECIFY_INIT_DIR="$TEST_REPO" \
    "$COPIED_SCRIPTS/setup-plan.sh"
[[ ! -e "$TEST_TMP/json-escape" ]] || fail "feature.json traversal wrote outside specs"
rm -f "$TEST_REPO/.specify/feature.json"

mkdir -p "$OUTSIDE/feature-target"
ln -s "$OUTSIDE/feature-target" "$TEST_REPO/specs/escape"
expect_failure "feature symlink escape" \
    env SPECIFY_INIT_DIR="$TEST_REPO" SPECIFY_FEATURE_DIRECTORY="specs/escape/004-link" \
    "$COPIED_SCRIPTS/setup-plan.sh"
[[ ! -e "$OUTSIDE/feature-target/004-link" ]] || fail "feature symlink escape wrote outside specs"

CONTROL_FEATURE=$'specs/005-control\nvalue'
expect_failure "feature control character" \
    env SPECIFY_INIT_DIR="$TEST_REPO" SPECIFY_FEATURE_DIRECTORY="$CONTROL_FEATURE" \
    "$COPIED_SCRIPTS/setup-plan.sh"

rm -f "$TEST_REPO/.specify/templates/plan-template.md"
printf '%s\n' '# Outside template' >"$OUTSIDE/plan-template.md"
ln -s "$OUTSIDE/plan-template.md" "$TEST_REPO/.specify/templates/plan-template.md"
mkdir -p "$TEST_REPO/specs/006-template-link"
expect_failure "template symlink escape" \
    env SPECIFY_INIT_DIR="$TEST_REPO" SPECIFY_FEATURE_DIRECTORY="specs/006-template-link" \
    "$COPIED_SCRIPTS/setup-plan.sh"
[[ ! -e "$TEST_REPO/specs/006-template-link/plan.md" ]] || fail "unsafe template left a plan file"

echo "security-contract-test: PASS"
