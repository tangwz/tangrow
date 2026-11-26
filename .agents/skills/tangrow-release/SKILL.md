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

- Release only from a clean, committed release commit: a verified `origin/main`
  commit, plus at most one commit that changes only `src/license/client.json`.
  Record that release SHA before packaging, and tag that same commit.
- Never package or distribute an owner build (`npm run build:owner`, banner
  prefix `/* Tangrow <version> owner build, no access checks |`).
- Never release with development license settings (`https://license.tangrow.invalid`,
  key ID `dev-1`, or the development key checked in `scripts/package.mjs`).
- Never commit private Ed25519 signing seeds, backend credentials, or local
  machine absolute paths.
- Keep `GPL-3.0-or-later` metadata and every legal notice file in the `files`
  array of `scripts/package.mjs` intact in the release ZIP (`LICENSE`, `NOTICE`,
  `THIRD_PARTY_NOTICES.md`, and any other notice that list names).
- Do not treat green unit tests alone as release sign-off. Record exact SHA,
  verification commands, archive checksum, and real-host acceptance status.

## Pre-Release Gate

Run from the Tangrow repository root:

1. **Pin the `main` commit and commit the release configuration**
   - Start from a clean checkout of `origin/main` and record
     `git rev-parse origin/main` as the release base.
   - Only on explicit user request, write the production endpoint and public
     keys into `src/license/client.json` and commit just that file on a release
     branch (for example `release/v<version>`) rather than `main`, so everyday
     builds keep the development placeholder. Never package from an uncommitted
     `client.json`: the tag would then lack the source the ZIP was built from,
     which `docs/LICENSING.md` forbids.
   - Verify `git status -s` is clean and that
     `git diff --name-only <release-base> HEAD` lists only
     `src/license/client.json` (or nothing, if `main` already carries the
     production configuration). Record `git rev-parse HEAD` as the release SHA.
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
   - For non-trivial release deltas, run `autoreview` (see
     `.agents/skills/autoreview/SKILL.md`) on the release commit against the
     previous release tag. Never use `--base origin/main` here: it equals the
     release base, so the range would be empty.
     ```bash
     git diff --stat <previous-release-tag> HEAD
     python3 "$HOME/.agents/skills/autoreview/scripts/autoreview" \
       --mode branch --base <previous-release-tag> \
       --max-priority P3 \
       --prompt-file .agents/skills/autoreview/review-checklist.md \
       --source-context docs/ACCESS-CONTRACT.md \
       --source-context scripts/package.mjs \
       --source-context docs/LICENSING.md
     ```
     If there is no earlier release tag, ask the user which commit to review
     from. A `scoped-clean` verdict over an empty range is not a review: when
     `git diff --stat` prints nothing, record that there was nothing new to
     review instead of a passing review.
4. **Build and verify the release archive**
   - Run `npm run package` to generate `dist/tangrow-<version>.zip`.
   - Verify the archive holds exactly the top-level `tangrow/` directory entry
     (created by `zip -q -r` in `scripts/package.mjs`) plus `tangrow/<name>` for
     each name in the `files` array of `scripts/package.mjs`, the same list
     `tests/package.test.ts` asserts. Read the list from the script rather than
     from memory, and allow no extra files or subdirectories:
     ```bash
     grep -m1 '^const files = ' scripts/package.mjs
     unzip -Z1 "dist/tangrow-<version>.zip" | sort
     ```
   - Confirm `main.js` header starts with `/* Tangrow <version> | GPL-3.0-or-later |`
     and compute `shasum -a 256 "dist/tangrow-<version>.zip"`.
5. **Verify temp-vault install & real-host acceptance**
   - Smoke-test installation against an isolated temporary Obsidian vault (never
     a personal vault). Create the vault in Obsidian first (or
     `mkdir -p /abs/path/to/temp-vault/.obsidian`), because the installer
     refuses a folder without `.obsidian`:
     ```bash
     npm run install:vault -- --vault /abs/path/to/temp-vault --dry-run
     npm run install:vault -- --vault /abs/path/to/temp-vault
     ```
   - Check applicable real-host gates before publishing:
     - Native IME & multi-window acceptance (`docs/NATIVE-IME-ACCEPTANCE.md`)
     - Real-device cross-vault storage sharing & upgrade retention (`docs/ACCESS-CONTRACT.md`, `docs/PURCHASE-ACTIVATION.md`)
     - Light/dark theme & sidebar visual sanity check
6. **Publish (only on explicit user request)**
   - Tag the release SHA recorded in step 1 (`v<version>` or repo tag
     convention), which contains the production `client.json` the ZIP was built
     from. Push the tag and publish a GitHub Release attaching
     `dist/tangrow-<version>.zip` along with corresponding source code per
     `docs/LICENSING.md`. Before publishing, confirm
     `git rev-parse "v<version>^{commit}"` prints the release SHA; the packager
     already checked that `main.js` matches a rebuild of that clean commit.
   - Report: version, exact SHA, release URL, ZIP SHA-256, checks executed, and
     any remaining real-host acceptance notes.
