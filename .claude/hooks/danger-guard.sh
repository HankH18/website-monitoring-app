#!/usr/bin/env bash
# Pre-Bash safety net. Returns exit 2 to BLOCK execution of dangerous commands.
# Bypass deliberately by editing this file or running the command yourself.
set -uo pipefail

INPUT="$(cat)"
CMD="$(printf "%s" "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
[[ -z "$CMD" ]] && exit 0

# Patterns of obviously-destructive commands. Tune for your environment.
DANGER_PATTERNS=(
  'rm[[:space:]]+-rf?[[:space:]]+/'
  'rm[[:space:]]+-rf?[[:space:]]+~'
  'rm[[:space:]]+-rf?[[:space:]]+\$HOME'
  'rm[[:space:]]+-rf?[[:space:]]+\.\.?(/|$| )'
  'mkfs\.'
  'dd[[:space:]]+if=.*[[:space:]]+of=/dev/'
  ':\(\)\{ :\|:& \};:'
  'chmod[[:space:]]+-R[[:space:]]+777[[:space:]]+/'
  'chown[[:space:]]+-R[[:space:]]+.*[[:space:]]+/'
  '>[[:space:]]*/dev/sd[a-z]'
  'aws[[:space:]]+s3[[:space:]]+rb[[:space:]]+.*--force'
  'aws[[:space:]]+s3[[:space:]]+rm[[:space:]]+s3://.*--recursive'
  'aws[[:space:]]+iam[[:space:]]+(delete-user|delete-role|delete-policy)'
  'aws[[:space:]]+lambda[[:space:]]+delete-function'
  'aws[[:space:]]+rds[[:space:]]+delete-db-(instance|cluster)'
  'DROP[[:space:]]+(DATABASE|SCHEMA)'
  'TRUNCATE[[:space:]]+TABLE'
  'git[[:space:]]+push[[:space:]]+(-f|--force)([[:space:]]+\S+)?[[:space:]]+(main|master|production|prod)'
  'git[[:space:]]+push[[:space:]]+\S+[[:space:]]+(main|master|production|prod)[[:space:]]+(-f|--force)'
  'git[[:space:]]+reset[[:space:]]+--hard[[:space:]]+(origin/)?(main|master|production)'
  'curl.+\|[[:space:]]*(sudo[[:space:]]+)?(bash|sh|zsh)'
  'wget.+\|[[:space:]]*(sudo[[:space:]]+)?(bash|sh|zsh)'
)

for pat in "${DANGER_PATTERNS[@]}"; do
  if printf "%s" "$CMD" | grep -qiE "$pat"; then
    cat <<MSG >&2
🛑 BLOCKED by .claude/hooks/danger-guard.sh
Command: $CMD
Pattern: $pat

If you genuinely need this, run it manually outside Claude Code,
or edit .claude/hooks/danger-guard.sh to remove the pattern.
MSG
    exit 2
  fi
done

exit 0