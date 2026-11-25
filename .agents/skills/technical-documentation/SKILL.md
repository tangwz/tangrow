---
name: technical-documentation
description: Author, update, and audit Tangrow technical documentation (README.md, CONTEXT.md, docs/*.md) and agent governance files (AGENTS.md, .agents/skills/*/SKILL.md) for accuracy, terminology consistency, and drift.
---

# Technical Documentation (Tangrow)

Keep Tangrow's product documentation, domain contracts, and agent governance
files accurate, concise, and aligned with the live codebase.

## Documentation Surfaces

Inventory the relevant surfaces before editing or reviewing:

- **Agent governance (source repo)**: `AGENTS.md`, `.agents/skills/*/SKILL.md`,
  `.agents/skills/autoreview/review-checklist.md`. Keep `AGENTS.md` canonical;
  if compatibility aliases (such as `CLAUDE.md`) are added later, keep them as
  thin references to `AGENTS.md` rather than duplicating policy.
  *(Distinguish this from the runtime vault-side `AGENTS.md` generated inside a
  user's companion folder.)*
- **Domain glossary (terminology source of truth)**: `CONTEXT.md`.
- **Product & architecture contracts**: `README.md`, `docs/DESIGN.md`,
  `docs/ZETTELKASTEN.md`, `docs/REPORTING.md`, `docs/ACCESS-CONTRACT.md`,
  `docs/PURCHASE-ACTIVATION.md`, `docs/NATIVE-IME-ACCEPTANCE.md`,
  `docs/PROVENANCE.md`, `docs/LICENSING.md`, `THIRD_PARTY_NOTICES.md`.
- **Historical dated snapshots** (preserve as dated records; do not silently
  rewrite past baselines): `docs/PARITY-AUDIT.md`, `docs/REUSE-AUDIT.md`.

## Workflow

1. **Classify the task**: `build` (write/update) vs `review` (audit/fix drift),
   and scope (targeted diff vs repo-wide audit).
2. **Verify against live source first**: read `CONTEXT.md`, `package.json`,
   `manifest.json`, `scripts/*.mjs`, `.github/workflows/ci.yml`, and the touched
   `src/` modules before writing or reviewing claims. Never audit docs from
   memory.
3. **Run a proactive drift sweep** across in-scope docs and governance files:
   - **Broken references**: verify relative Markdown links, file paths, and
     heading anchors resolve inside the repository.
   - **Command & script accuracy**: verify every `npm run ...`, CLI flag, and CI
     command matches `package.json`, `scripts/*.mjs`, and `.github/workflows/ci.yml`.
   - **Metadata parity**: verify version, `minAppVersion`, `GPL-3.0-or-later`,
     and release/install file lists agree with `manifest.json`, `package.json`,
     `scripts/package.mjs`, and `scripts/install.mjs`.
   - **Terminology compliance**: check wording against `CONTEXT.md`, especially
     every `_Avoid_` boundary (e.g., Journal vs 日记, 速记 vs 快速新建, 卡片 vs
     普通笔记, 写作暂存 vs 稿件, 候选素材 vs 正文引用).
   - **Implementation vs proposal clarity**: ensure partially implemented design
     docs (such as `docs/DESIGN.md` and `docs/ZETTELKASTEN.md`) clearly separate
     shipped behavior from planned work.
   - **Governance consistency**: check `AGENTS.md` and `.agents/skills/*/SKILL.md`
     for conflicting rules, stale paths, or duplicated instructions.
   - **Privacy & provenance hygiene**: flag local machine absolute paths
     (`/Users/...`, `C:\...`), private vault paths, secrets, or unsupported
     parity/equivalence claims (`docs/PROVENANCE.md`).
4. **Apply scoped fixes** (unless report-only mode was requested):
   - Keep prose operational and concrete; match the existing language of each
     document (`zh-CN` for user/product docs and `CONTEXT.md`, concise English or
     bilingual alignment where established in agent/skill files).
   - When updating user-facing feature descriptions in `README.md`, cross-check
     command names and labels against `src/locales/*.zh-CN.json` and `src/i18n.ts`.
5. **Report clearly**: list surfaces audited, concrete drift fixed (or findings
   with `file:line`), commands verified, and any intentional gaps left open.
