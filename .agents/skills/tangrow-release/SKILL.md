---
name: tangrow-release
description: Prepare, verify, package, and publish Tangrow Obsidian plugin releases. Use when cutting a release ZIP, checking version/GPL/public-key prerequisites, running npm run package, testing temp-vault installation, or publishing a GitHub Release.
---

# Tangrow Release

Tangrow releases are manual-only. Merging to `main` does not package or publish
a release. Never cut a Git tag, upload a GitHub Release, or write production
keys into `src/license/client.json` unless the user explicitly asked for that
release action.

## Safety Rules

- Release only from a clean commit on `origin/main`, and record the exact commit
  SHA before packaging or tagging.
- Never package or distribute an owner build (`npm run build:owner`, banner
  prefix `/* Tangrow <version> owner build, no access checks |`).
- Never release with development license settings (`https://license.tangrow.invalid`,
  key ID `dev-1`, or the development key checked in `scripts/package.mjs`).
- Never commit private Ed25519 signing seeds, backend credentials, or local
  machine absolute paths.
- Keep `GPL-3.0-or-later` metadata and all 4 legal notice files intact in the
  release ZIP (`LICENSE`, `NOTICE`, `LICENSE-MIT-LEGACY`, `THIRD_PARTY_NOTICES.md`).
- Do not treat green unit tests alone as release sign-off. Record exact SHA,
  verification commands, archive checksum, and real-host acceptance status.

## Pre-Release Gate

Run from the Tangrow repository root:

1. **Pin exact `main` commit and clean tree**
   - Verify `git status -s` is clean (aside from intentional local production
     `src/license/client.json` override if kept uncommitted—state explicitly if
     so, and confirm `scripts/package.mjs` rebuild equality passes).
   - Record `git rev-parse HEAD` and confirm it matches `origin/main`.
2. **Verify version, license, and production client configuration**
   - Confirm `manifest.json` (`id: "tangrow"`, `version`, `minAppVersion`) agrees
     with `package.json` (`version`, `license: "GPL-3.0-or-later"`).
   - Confirm `src/license/client.json` contains only `endpoint` (production
     HTTPS origin, no path/trailing slash, not `.invalid`/`localhost`/`example.*`)
     and `keys` (valid 43-char base64url 32-byte Ed25519 public keys, no `dev-1`
     or development key).
3. **Run deterministic build, tests, and independent review**
   - Run `npm run build && npm test`.
   - Confirm packaging, installer, license format, and access tests passed
     (`tests/package.test.ts`, `tests/install.test.ts`, `tests/license-format.test.ts`,
     `tests/access.test.ts`).
   - For non-trivial release deltas, run `autoreview` at `--max-priority P3`
     using `.agents/skills/autoreview/SKILL.md` with:
     `--source-context docs/ACCESS-CONTRACT.md --source-context scripts/package.mjs --source-context docs/LICENSING.md`.
4. **Build and verify the release archive**
   - Run `npm run package` to generate `dist/tangrow-<version>.zip`.
   - Verify archive entries match the exact 7-file allowlist:
     ```bash
     unzip -Z1 "dist/tangrow-<version>.zip"
     ```
     Expected entries only:
     `tangrow/manifest.json`, `tangrow/main.js`, `tangrow/styles.css`,
     `tangrow/LICENSE`, `tangrow/NOTICE`, `tangrow/LICENSE-MIT-LEGACY`,
     `tangrow/THIRD_PARTY_NOTICES.md`.
   - Confirm `main.js` header starts with `/* Tangrow <version> | GPL-3.0-or-later |`
     and compute `shasum -a 256 "dist/tangrow-<version>.zip"`.
5. **Verify temp-vault install & real-host acceptance**
   - Smoke-test installation against an isolated temporary Obsidian vault (never
     a personal vault):
     ```bash
     npm run install:vault -- --vault /abs/path/to/temp-vault --dry-run
     npm run install:vault -- --vault /abs/path/to/temp-vault
     ```
   - Check applicable real-host gates before publishing:
     - Native IME & multi-window acceptance (`docs/NATIVE-IME-ACCEPTANCE.md`)
     - Real-device cross-vault storage sharing & upgrade retention (`docs/ACCESS-CONTRACT.md`, `docs/PURCHASE-ACTIVATION.md`)
     - Light/dark theme & sidebar visual sanity check
6. **Publish (only on explicit user request)**
   - Tag the exact verified SHA (`v<version>` or repo tag convention), push tag,
     and publish GitHub Release attaching `dist/tangrow-<version>.zip` along with
     corresponding source code per `docs/LICENSING.md`.
   - Report: version, exact SHA, release URL, ZIP SHA-256, checks executed, and
     any remaining real-host acceptance notes.
