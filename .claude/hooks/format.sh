#!/usr/bin/env bash
# Polyglot post-edit formatter. Reads Claude Code hook JSON from stdin.
# Failures never block — formatting is best-effort.
set -uo pipefail

INPUT="$(cat)"
FILE="$(printf "%s" "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)"
[[ -z "$FILE" || ! -f "$FILE" ]] && exit 0

case "$FILE" in
  *.js|*.jsx|*.ts|*.tsx|*.mjs|*.cjs|*.json|*.jsonc|*.md|*.mdx|*.yml|*.yaml|*.css|*.scss|*.html)
    if command -v biome >/dev/null 2>&1 && [[ -f biome.json || -f biome.jsonc ]]; then
      biome format --write "$FILE" >/dev/null 2>&1 || true
    elif [[ -x node_modules/.bin/prettier ]]; then
      node_modules/.bin/prettier --write --log-level silent "$FILE" >/dev/null 2>&1 || true
    elif command -v prettier >/dev/null 2>&1; then
      prettier --write --log-level silent "$FILE" >/dev/null 2>&1 || true
    fi
    ;;
  *.py)
    if command -v ruff >/dev/null 2>&1; then
      ruff format "$FILE" >/dev/null 2>&1 || true
      ruff check --fix --quiet "$FILE" >/dev/null 2>&1 || true
    elif command -v black >/dev/null 2>&1; then
      black --quiet "$FILE" 2>/dev/null || true
    fi
    ;;
  *.go)
    command -v gofmt   >/dev/null 2>&1 && gofmt -w "$FILE"   2>/dev/null || true
    command -v goimports >/dev/null 2>&1 && goimports -w "$FILE" 2>/dev/null || true
    ;;
  *.rs)
    command -v rustfmt >/dev/null 2>&1 && rustfmt --quiet "$FILE" 2>/dev/null || true
    ;;
  *.tf|*.tfvars)
    command -v terraform >/dev/null 2>&1 && terraform fmt "$FILE" >/dev/null 2>&1 || true
    ;;
  *.sh|*.bash)
    command -v shfmt >/dev/null 2>&1 && shfmt -w -i 2 "$FILE" 2>/dev/null || true
    ;;
  *.rb)
    command -v rubocop >/dev/null 2>&1 && rubocop -A --force-exclusion "$FILE" >/dev/null 2>&1 || true
    ;;
esac

exit 0