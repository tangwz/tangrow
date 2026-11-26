---
name: autoreview
description: Structured independent code review for Tangrow via the shared OpenClaw autoreview skill.
---

# Auto Review (Tangrow)

Use the canonical [autoreview skill](https://github.com/openclaw/agent-skills/tree/main/skills/autoreview).
Read the complete installed `~/.agents/skills/autoreview/SKILL.md` and the references
it requires before reviewing. If installed at another operator-selected location,
use that installation. This repository entrypoint contains no review implementation.

If the skill is missing, reuse or clone `https://github.com/openclaw/agent-skills`
and run `python3 scripts/install-skills autoreview` from that checkout. On Windows,
use `python`; `--mode copy` is available when symlinks are unavailable.

Run the shared `scripts/autoreview` helper with Python from the Tangrow repository
root, preserving its working directory. Follow this repository's review checklist
and `AGENTS.md` requirements in addition to the canonical skill.

## Tangrow defaults

Always pass the repository checklist via `--prompt-file .agents/skills/autoreview/review-checklist.md`.
Preserve any explicit user-selected `--engine`, `--model`, `--thinking`,
`--codex-speed`, or `--max-priority`.

Routine local development review (uncommitted changes, P0–P2):

```bash
python3 "$HOME/.agents/skills/autoreview/scripts/autoreview" \
  --mode local \
  --max-priority P2 \
  --prompt-file .agents/skills/autoreview/review-checklist.md
```

Pre-PR / high-risk branch review (licensing, access gating, packaging, or
persistence changes, P0–P3). For a release, use the previous release tag as
`--base` instead, as `.agents/skills/tangrow-release/SKILL.md` describes; on a
clean `main`, `--base origin/main` selects an empty range:

```bash
python3 "$HOME/.agents/skills/autoreview/scripts/autoreview" \
  --mode branch --base origin/main \
  --max-priority P3 \
  --prompt-file .agents/skills/autoreview/review-checklist.md
```

For an uncommitted PR candidate against the branch merge base:

```bash
merge_base=$(git merge-base HEAD origin/main)
python3 "$HOME/.agents/skills/autoreview/scripts/autoreview" \
  --mode local --base "$merge_base" \
  --max-priority P3 \
  --prompt-file .agents/skills/autoreview/review-checklist.md
```

When Codex CLI is unavailable or explicitly overridden, pass `--engine claude`
(or follow the canonical skill's fallback rules) and state why.

## Supplying unchanged context

Because the reviewer sandbox is intentionally empty, attach relevant frozen
contracts with repeatable `--source-context <path>` in `branch` or `commit` mode
when reviewing high-risk subsystems:

| Touched area | Recommended `--source-context` files |
| --- | --- |
| Licensing, trial, activation, access gating | `docs/ACCESS-CONTRACT.md`, `docs/PURCHASE-ACTIVATION.md`, `src/types.ts` |
| Reporting, cards, knowledge workbench | `docs/REPORTING.md`, `CONTEXT.md`, `src/report-contract.ts`, `src/types.ts` |
| Writing drafts, capture, IME, folders | `docs/DESIGN.md`, `docs/NATIVE-IME-ACCEPTANCE.md`, `src/types.ts` |
| Build flags, release packaging, notices | `scripts/plugin-build.mjs`, `scripts/package.mjs`, `docs/LICENSING.md` |

## Runtime and repository hygiene

- Keep `--output`, `--json-output`, and `--status-output` outside this repository.
- On macOS, do not override `TMPDIR`/`TMP`/`TEMP` to shared `/tmp` or `/var/tmp`
  paths; let Codex preflight use the private temporary directory.
- Do not commit real credentials, signing seeds, or local machine paths; avoid
  naming new test fixtures with credential-matching filenames such as
  `access-token.json` or `device-secret.json`.
- Verify every finding against the actual code and tests before acting. Fix real
  defects and data-loss, security, or licensing risks; decline unlikely low-value
  edge cases with a one-line reason. Never rerun purely for a nicer verdict.
- Keep shared helper fixes upstream in `openclaw/agent-skills`. Do not add
  repository-local helper or test copies.
