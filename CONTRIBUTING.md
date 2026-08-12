# Contributing to OrchBun

Human-authored and agent-authored pull requests are welcome.

## Before opening a pull request

1. Keep the change focused and explain the user problem it solves.
2. Run `npm run check` and `npm run build`.
3. Add or update tests for CLI behavior, memory safety, and web interactions.
4. Do not commit local `memory/`, raw agent transcripts, provider credentials, or generated `dist/` files.
5. Disclose substantial agent assistance in the pull-request description so reviewers can calibrate their review; the contributor remains responsible for the code and verification.

Changes to memory publication, milestone approval, filesystem access, or work-mode execution deserve explicit safety notes. Keep filesystem operations project-scoped and preserve the local-only `127.0.0.1` web binding.
