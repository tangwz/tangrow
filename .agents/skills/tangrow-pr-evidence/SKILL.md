---
name: tangrow-pr-evidence
description: Prepare, verify, or review Tangrow GitHub PRs and issues with real-host evidence, before/after visual proof capture, live GitHub check verification, and clean maintainer handoff.
---

# Tangrow PR Evidence & Review

Use this skill when preparing PR proof, attaching real-host screenshots/videos
to a PR, or reviewing/triaging a Tangrow PR before merge.

## Start With Live GitHub State

Verify live PR or issue state against `tangwz/tangrow` before commenting,
recommending merge, or handoff:

```bash
gh pr view <number> --repo tangwz/tangrow \
  --json title,body,author,labels,comments,files,commits,statusCheckRollup,reviewDecision,url,additions,deletions,changedFiles
```

## Review Evidence Bar

Match the proof required to the risk of the change:

- **Bug fixes**: require observed symptom, root cause in the touched code path,
  and a regression test in `tests/*.test.ts` (plus real-host repro when
  host-dependent).
- **UI, layout, or theme changes**: require real-host screenshots or video of
  the affected view (covering light/dark theme and narrow sidebar or report
  widths when relevant). Unit tests supplement visual proof; they do not replace
  it.
- **Native IME, multi-window, or cross-vault access changes**: follow
  `docs/NATIVE-IME-ACCEPTANCE.md` and `docs/ACCESS-CONTRACT.md`. Clearly label
  and separate:
  - physical keyboard / live Obsidian host evidence,
  - automated keystroke / scripted host checks, and
  - mocked unit/integration tests.
- Never present static HTML mockups (`docs/design/*.html`), synthetic images,
  or mocked unit tests as live Obsidian host proof.
- Do not merge or recommend merge based only on PR prose, AI rationale, or green
  CI when changed user-visible behavior has not been exercised.

## Capturing & Attaching Proof

1. **Use an isolated temporary vault**: create it in Obsidian first (or
   `mkdir -p /abs/path/to/temp-vault/.obsidian`), because the installer refuses
   a folder without `.obsidian`. Then install the candidate build with
   `npm run install:vault -- --vault /abs/path/to/temp-vault`. Never record
   against a personal vault containing private notes.
   - For UI proof that is not about access gating, build with
     `npm run build:owner` so the feature is reachable without a trial. A
     production `npm run build` shows the access gate, and starting its trial
     spends this device's single 24-hour trial, which every vault on the
     device shares. Use production builds only for access-gate evidence.
2. **Keep proof artifacts out of Git**: store raw screenshots, recordings, and
   comment drafts in gitignored local directories (such as `output/` or a
   private directory outside the repo). Never commit PR proof videos or ad-hoc
   captures to repository branches.
3. **Hold comparisons constant**: for before/after proof, keep the same Obsidian
   version, theme, vault fixture, window/sidebar width, and interaction steps.
   - Label baseline captures explicitly as **BEFORE — expected failure** and
     candidate captures as **AFTER — passing result**.
   - Lead the PR comment with the passing candidate; disclose any companion fix
     or simulated step beside it.
   - If editing a video clip, preserve the raw capture, burn concise captions
     into MP4 if needed, keep decisive transitions at 1× speed, and hold the
     final result clearly in frame.
4. **Inspect before upload**: open every final image/video and verify no private
   note text, API keys, redemption codes, license tokens, or local machine
   usernames/paths appear.
5. **Attach directly to the PR**:
   - `--attach` exists only in newer GitHub CLI releases (present in
     `gh 2.105.0`, absent in `2.96.0`), and older versions fail with
     `unknown flag: --attach` before posting anything. Run the command below
     only when `gh pr comment --help | grep -q -- --attach` succeeds:
     ```bash
     gh pr comment <number> --repo tangwz/tangrow \
       --body-file /path/to/ignored/pr-proof.md \
       --attach /path/to/ignored/after.png
     ```
   - Otherwise, drag the inspected image/video into a PR comment box in the
     GitHub web UI. GitHub uploads it and inserts a
     `https://github.com/user-attachments/assets/...` link. Either post that
     comment from the web UI, or copy the link into the body file and run
     `gh pr comment <number> --repo tangwz/tangrow --body-file ...` without
     `--attach`. Never commit proof media to a repository branch as a
     workaround.
   - Include exact branch/commit SHA, OS & Obsidian version, fixture setup,
     validation commands (`npm run build && npm test`, `autoreview` verdict),
     and known limitations in the comment body. If attachment upload fails, keep
     the local files and report the exact failure instead of claiming upload
     succeeded.

## GitHub Comment & Action Hygiene

- Use `--body-file` or a single-quoted heredoc (`<<'EOF'`) for multiline `gh`
  bodies; never pass literal `\n` escapes in shell strings.
- Leave issue/PR references like `#10` outside backticks when GitHub
  auto-linking is desired.
- Keep review comments concise: finding, evidence, requested change, and
  verification path.
- Never merge, close PRs/issues, delete branches, or push release tags unless
  the user explicitly asked for that action.
