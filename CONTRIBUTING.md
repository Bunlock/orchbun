# Contributing to OrchBun

Pull requests authored by humans or agents are welcome.

## Before opening a pull request

1. Keep the change focused and explain the user problem that it solves.
2. Run `npm run check` and `npm run build`.
3. Add or update tests covering CLI behavior, memory safety, and web interactions.
4. Do not commit local `memory/`, raw agent transcripts, provider credentials, or generated `dist/` files.
5. Disclose substantial agent assistance in the pull-request description so reviewers can calibrate their review. The contributor remains responsible for the code and its verification.

Changes involving memory publication, milestone approval, filesystem access, or work-mode execution require explicit safety notes. Keep filesystem operations project-scoped and preserve the local-only `127.0.0.1` web binding.
