# Tangrow Review Checklist

Focus on actionable defects, regressions, race conditions, data loss, security,
and contract violations specific to this Obsidian plugin. Do not report style
nits or speculative refactors.

## 1. Vault Data Safety & Additive Boundaries
- Never silently move, rename, reclassify, or batch-rewrite existing user notes,
  folders, or templates.
- Writes must be triggered by explicit user actions and preserve source notes on
  capture processing or card derivation.
- Draft submission and capture recovery paths must recognize already-written
  files (e.g., `tangrow_submission_id` and processing receipts) so retries do
  not duplicate notes or discard unsaved edits.
- Companion folder (`99-Tangrow` or configured folder) setup and migration must
  never overwrite user-customized `.base`/doc content or conflict with content
  folders.

## 2. Multi-Window, Async Concurrency & IME Integrity
- Shared draft/composer state (`composer`/`scratch`), IME composition locks
  (`src/draft-composition.ts`), and async save queues (`src/draft-submissions.ts`)
  must prevent stale async writes from overwriting newer user input and must
  unlock cleanly when a composing window closes or reloads.
- Never reject `compositionend` based on `event.isTrusted` (macOS native IMEs
  such as WeChat IME emit untrusted `compositionend` on candidate commit).
- Multi-window workspace lookups must scope to the originating container
  (`leaf.getContainer()`) instead of assuming a single global window/document.

## 3. Licensing, Access Coordination & Release Packaging
- Ed25519 lease verification (`src/license/format.ts`) must verify raw UTF-8
  JSON payload bytes without re-serializing/reordering keys; expired leases are
  renewable, not signature failures.
- Cross-vault shared lease coordination (`src/access.ts`,
  `src/access-coordination.ts`) must discard stale `active` or error responses
  if another vault updated the lease mid-flight, and apply `released`/`revoked`
  only when the license identity and `tangrow:binding:v1` activation marker
  still match the request start.
- Release packaging (`scripts/package.mjs`, `scripts/plugin-build.mjs`,
  `src/license/client.json`) must block `--owner` no-gate builds, development
  keys (`dev-1`), non-HTTPS/dev endpoints, and stale bundles.

## 4. Obsidian Lifecycle, UI & Localization
- All event listeners, timers, `access.subscribe` hooks, DOM injections, and
  immersive layout states must be cleaned up reliably on `onunload()`/`dispose()`.
- Preserve default `zh-CN` and runtime `en` switching without hardcoded UI copy
  or contradicting domain terminology in `CONTEXT.md`.
- Keep styles scoped so they do not leak into or break Obsidian host chrome.

## 5. Provenance, Licensing & Privacy
- Report suspected real credentials, private signing seeds, or plaintext secret
  exposure as P0 (without reproducing secret values).
- Flag accidental commits of local absolute paths, private notes/exports, or
  licensing metadata drift (`GPL-3.0-or-later`, `NOTICE`, `LICENSE-MIT-LEGACY`,
  `THIRD_PARTY_NOTICES.md`).
