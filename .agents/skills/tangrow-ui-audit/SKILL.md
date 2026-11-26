---
name: tangrow-ui-audit
description: Audit Tangrow's Obsidian plugin CSS (styles.css), UI DOM code, and rendered views for selector scoping, Obsidian CSS token compliance, narrow-sidebar/report overflow, light/dark theme parity, accessibility, and localization consistency.
---

# Tangrow UI Audit

Audit Tangrow's interface against Obsidian-native styling, multi-window hygiene,
and accessibility contracts. Separate deterministic source violations from
judgment-based suggestions; never present aesthetic preference as an error.

## Workflow

1. Read [rubric.md](rubric.md) and identify the affected surfaces (sidebar,
   quick-add modal/menu, capture panel/window, immersive view, 8-page report,
   annual heatmap, settings center, or access gate).
2. Run **deterministic source checks** on `styles.css` and touched `src/*.ts` UI
   files before making judgment calls:
   - Check CSS selector scoping (`css/unscoped-selector`), raw palette values
     (`token/raw-color`), undefined `--tangrow-*` tokens (`token/undefined`), and
     reduced-motion handling (`a11y/reduced-motion`).
   - Check UI code for Obsidian `setIcon` usage (`icon/host-setIcon`),
     localization via `src/i18n.ts` + `src/locales/*.zh-CN.json`
     (`i18n/hardcoded-copy`), accessible names & keyboard navigation
     (`a11y/name`, `a11y/focus`), lifecycle cleanup (`dom/cleanup`), and
     multi-window container scoping (`dom/container-scope`).
3. Inspect **rendered UI** when visual or layout changes are in scope (and
   explicitly state whether evidence came from a live Obsidian temporary vault
   or a static preview):
   - Verify both **light** and **dark** Obsidian themes (`theme/parity`).
   - Verify narrow sidebar breakpoints (`180px`, `260px`), report/settings
     widths (`360px`, `440px`, `740px`, `920px`), and the capture panel's
     `min-width: 360px` rule (`layout/overflow`). These match the `@container`
     rules in `styles.css` today; list them with
     `grep -n '@container' styles.css` before auditing, since new breakpoints
     may be added.
   - Verify empty, loading, typical, dense, error, disabled, and access-gated
     states where applicable (`component/state`).
4. Emit curated findings using the format below. When asked to fix findings,
   apply narrow, scoped edits only—do not perform unrelated visual redesigns—and
   verify with `npm run build && npm test`.

## Finding Format & Curation

Every finding must cite:

- `file:line` (or rendered viewport/theme state when visual-only)
- `rule ID` from [rubric.md](rubric.md)
- `severity` (`error`, `warning`, or `info`)
- `basis` (`mechanical` or `judgment`)
- concrete evidence and a concise remediation

Curation rules:

- Report every `error`.
- Rank `warning` before `info`, then by user impact / affected scope.
- Cap concise reports at 5 non-error items and summarize any remainder by count.
- Zero `error`, zero `warning`, and 5 or fewer `info` findings indicates no
  significant UI drift.
- Never invent source locations, CSS tokens, or rendered visual observations.
