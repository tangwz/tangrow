# Tangrow UI Audit Rubric

## Mechanical Rules

| ID | Check |
| --- | --- |
| `css/unscoped-selector` | Selector in `styles.css` lacks a `.tangrow-*` / Tangrow-owned scope and can leak into Obsidian host chrome |
| `token/raw-color` | Hardcoded hex or raw palette color where an Obsidian semantic token (`--text-*`, `--background-*`, `--interactive-accent`, etc.) or `color-mix(...)` should be used |
| `token/undefined` | Custom `--tangrow-*` variable referenced without a definition in its scope |
| `icon/host-setIcon` | Bundled or copied raw third-party SVG icon instead of Obsidian's `setIcon` (`THIRD_PARTY_NOTICES.md`) |
| `i18n/hardcoded-copy` | User-visible label, tooltip, placeholder, `aria-label`, or notice bypasses `src/i18n.ts` / `src/locales/*.zh-CN.json` |
| `a11y/name` | Interactive control or icon-only button lacks an accessible name (`aria-label` or visible text) |
| `a11y/focus` | Keyboard focus ring (`:focus-visible`) is removed without replacement, or menus/modals break `Esc`/arrow/`Enter` focus flow |
| `a11y/reduced-motion` | New animation or transition ignores `prefers-reduced-motion` |
| `component/state` | Interactive control lacks coherent hover, focus, active, disabled, selected, or error state |
| `layout/overflow` | Text, heatmap, table, or toolbar clips or causes accidental horizontal overflow at sidebar (`180px`/`260px`) or pane (`440px`/`740px`/`920px`) widths |
| `theme/parity` | Light or dark Obsidian theme loses text legibility, contrast, borders, or visual hierarchy |
| `dom/cleanup` | Listeners, timers, `access.subscribe` hooks, body classes, or immersive DOM state are not cleaned up on `onunload()`/`dispose()` |
| `dom/container-scope` | Multi-window view assumes global `window`/`document` or `getMostRecentLeaf()` instead of `leaf.getContainer()` / owner document |

## Judgment Checks

| ID | Check |
| --- | --- |
| `hierarchy/primary-action` | Competing primary actions obscure the main action in a panel or modal |
| `layout/density` | Spacing, nested cards, or section framing wastes narrow sidebar space or breaks scanability |
| `copy/terminology` | UI copy is vague or contradicts domain terms in `CONTEXT.md` |

## Severity

- `error`: host CSS leak, broken interaction, accessibility barrier, illegible
  light/dark theme, accidental clipping/overflow, missing cleanup/container
  scoping, or hardcoded user-facing copy breaking bilingual switching.
- `warning`: likely visual drift, weak contrast/state feedback, or terminology
  inconsistency with meaningful user impact.
- `info`: low-impact polish opportunity.

Do not report personal aesthetic preference as a violation. Every finding needs
source or rendered evidence tied to a rule above.
