# Tangrow Repository Agent Guide

This file governs coding agents working on the Tangrow Obsidian plugin source
repository (not the runtime vault-side `AGENTS.md` generated inside a user's
companion folder).

## Key References

Read the relevant contracts before modifying a subsystem:
- Domain terminology: `CONTEXT.md`
- Product positioning & core loop: `docs/POSITIONING.md`
- Architecture & additive boundaries: `docs/DESIGN.md`, `docs/ZETTELKASTEN.md`
- PARA folders, filing destinations & archive decision: `docs/PARA.md`
- AI organizing engine (proposal): `docs/AI-ENGINE.md`
- Licensing & cross-vault access contract: `docs/ACCESS-CONTRACT.md`, `docs/PURCHASE-ACTIVATION.md`
- Reporting metrics & semantics: `docs/REPORTING.md`
- Native IME & multi-window acceptance: `docs/NATIVE-IME-ACCEPTANCE.md`
- Provenance & GPLv3 licensing: `docs/PROVENANCE.md`, `docs/LICENSING.md`
- Design prototypes & review notes: `docs/design/` (static HTML mockups, not
  host proof; see `.agents/skills/tangrow-pr-evidence/SKILL.md`)

## Build, Typecheck & Test

- Typecheck only: `npm run typecheck`
- Build (typecheck + production bundle): `npm run build`
- Full test suite: `npm test`
- Targeted test file: `npx tsx --test tests/<name>.test.ts`
- Owner local build (never release): `npm run build:owner`
- Release archive check (requires production `src/license/client.json` + clean build): `npm run package`

## Coding & Safety Conventions

- TypeScript ESM with `strict: true` and `noUncheckedIndexedAccess: true`.
- Preserve Tangrow's additive, local-first boundary: do not silently move,
  rename, or rewrite existing user notes; use `tangrow_` frontmatter keys.
- Keep user-facing strings localized (`zh-CN` default + `en`) and aligned with
  `CONTEXT.md`.
- Never commit real credentials, private Ed25519 seeds, production secrets,
  local machine absolute paths, or unauthorized third-party code/assets.

## Pre-Commit & Pre-PR Gates

1. **Deterministic verification (required)**: Run `npm run build && npm test`
   before commit or PR handoff (matches `.github/workflows/ci.yml`). Keep edits
   scoped and add regression tests for bug fixes or contract changes.
2. **Independent code review (`autoreview`)**: For non-trivial code changes,
   run the shared `autoreview` workflow defined in
   `.agents/skills/autoreview/SKILL.md` (with
   `--prompt-file .agents/skills/autoreview/review-checklist.md`) until no
   accepted actionable findings remain, unless equivalent manual review already
   happened, the change is trivial/docs-only, or the user opts out.
   - Use `--max-priority P2` for routine development.
   - Use `--max-priority P3` before release or for changes touching licensing,
     access coordination, persistence/draft recovery, or packaging.
   - In `branch` or `commit` mode, pass relevant contracts via
     `--source-context` because the reviewer sandbox is empty.
3. **Real-host acceptance (when applicable)**: Static review and mocks cannot
   certify native IME behavior, multi-window focus, live Obsidian layout, or
   real-device storage sharing. Follow `docs/NATIVE-IME-ACCEPTANCE.md`,
   `docs/ACCESS-CONTRACT.md`, and `.agents/skills/tangrow-pr-evidence/SKILL.md`
   when touching those surfaces.

## Repository Skills & Workflows

Use the matching skill under `.agents/skills/` when working on these areas:

| Skill | Use for |
| --- | --- |
| `.agents/skills/autoreview/SKILL.md` | Independent diff code review via the shared `autoreview` helper (`--prompt-file .agents/skills/autoreview/review-checklist.md`) |
| `.agents/skills/tangrow-release/SKILL.md` | Manual release packaging (`npm run package`), production license config checks, temp-vault smoke install, and GitHub Release publishing |
| `.agents/skills/tangrow-ui-audit/SKILL.md` | `styles.css` selector scoping, Obsidian CSS token compliance, light/dark & narrow-sidebar UI audit, accessibility, and i18n checks |
| `.agents/skills/tangrow-pr-evidence/SKILL.md` | PR review evidence bar, real-Obsidian proof capture & before/after attachments, and live `gh pr` verification |
| `.agents/skills/technical-documentation/SKILL.md` | Authoring and drift-auditing `README.md`, `CONTEXT.md`, `docs/*.md`, `AGENTS.md`, and `.agents/skills/` |

Shared agent workflows: install or symlink
`https://github.com/openclaw/agent-skills` for `autoreview` at
`~/.agents/skills/autoreview`. Keep shared helper fixes upstream and do not
vendor helper copies into this repository.
