---
description: Run tests via test-runner, then commit (no push) if green.
---

1. Invoke the `test-runner` sub-agent. If it returns any failures, STOP and report them — do not commit.
2. Run any project linters (npm run lint, ruff check, cargo clippy, etc.) if present. Surface errors.
3. If everything is green:
   - `git status` to confirm scope
   - `git add -A`
   - `git commit -m "<message>"` — message comes from $ARGUMENTS, or generate a Conventional Commits message summarizing the diff if $ARGUMENTS is empty
4. Do NOT push. Show the commit hash and summary; let the human push.