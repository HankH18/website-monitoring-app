#!/usr/bin/env bash
# On Stop, run the project test suite. Exit 2 to keep Claude going if tests fail.
# Bypass: touch .claude/SKIP_TESTS  (e.g. when explicitly debugging tests themselves).
set -uo pipefail

INPUT="$(cat)"
ACTIVE="$(printf "%s" "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo false)"

# Avoid infinite loop: if we already triggered the stop hook, let Claude finish.
[[ "$ACTIVE" == "true" ]] && exit 0
[[ -f .claude/SKIP_TESTS ]] && exit 0

# Quick guard: if no source files changed in the last 10 min, skip tests.
# (Saves quota when the user just chats with Claude without editing.)
if command -v git >/dev/null 2>&1 && [[ -d .git ]]; then
  if [[ -z "$(git status --porcelain)" ]]; then
    exit 0
  fi
fi

run() {
  local label="$1"; shift
  local out
  if out="$("$@" 2>&1)"; then
    return 0
  else
    cat <<MSG >&2
✗ $label failed. Tests must pass before stopping.
$out
MSG
    return 1
  fi
}

if [[ -f package.json ]] && jq -e '.scripts.test' package.json >/dev/null 2>&1; then
  run "npm test" npm test --silent || exit 2
elif [[ -f pyproject.toml || -f pytest.ini || -f setup.cfg ]] && command -v pytest >/dev/null 2>&1; then
  run "pytest"   pytest -q || exit 2
elif [[ -f Cargo.toml ]]; then
  run "cargo test" cargo test --quiet || exit 2
elif [[ -f go.mod ]]; then
  run "go test"   go test ./... || exit 2
fi

exit 0