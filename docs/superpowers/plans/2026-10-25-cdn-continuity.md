# CDN Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume a paused signed HLS job from an equivalent playlist after the source page moves to another CDN.

**Architecture:** Record hashes for committed media bytes in the download state. A separate continuity module selects a media playlist from source-tab network records and validates playlist structure and byte proofs before the UI replaces the job playlist. A new background message restricts candidates to the original source tab.

**Tech Stack:** Manifest V3, ES modules, Chrome runtime/tabs/storage, Node test runner, local HTTP fixtures.

**Spec:** `docs/superpowers/specs/2026-10-25-cdn-continuity-design.md`

## Global Constraints

- Never transplant signed query parameters across origins.
- Keep the existing writer and committed prefix; discard uncommitted pending bytes on adoption.
- Do not reload the current Chrome workbench while its task is unfinished.
- No new manifest permissions or remote code.

---

### Task 1: Record media proofs

**Files:** Modify `lib/downloader.js`; test `tests/downloader.test.js`.

**Interfaces:** `createDownloadState()` exposes `firstSegmentProof`, `lastSegmentProof` and `initProof` as committed-byte hashes; `readMediaSegment(segment, format, options)` returns validated decoded bytes.

- [x] Add a failing disk-mode test asserting the digest of committed segments and initialization bytes.
- [x] Run `node --test tests/downloader.test.js` and confirm the missing proof assertion fails.
- [x] Hash validated bytes after successful writes; expose the shared segment reader.
- [x] Run the test again and confirm it passes.

### Task 2: Validate a replacement playlist

**Files:** Create `lib/continuity.js`; test `tests/continuity.test.js`.

**Interfaces:** `findReplacementPlaylist(original, state, sourceUrls, { signal })` resolves an equivalent media playlist or throws a user-facing error. It uses `loadPlaylist`, `fetchBytes`, and `readMediaSegment`.

- [x] Add failing local-server tests for host/date rotation with equal bytes, quality mismatch, changed order, changed committed bytes and zero proof.
- [x] Run `node --test tests/continuity.test.js` and confirm failures are due to missing implementation.
- [x] Implement candidate selection, structural comparison, and SHA-256 proof checks.
- [x] Run the targeted tests again and confirm they pass.

### Task 3: Wire paused-job recovery

**Files:** Modify `background.js`, `download.js`, `download.html`, `styles.css`; test `tests/background.test.js`, `tests/ui-smoke.mjs`.

**Interfaces:** `GET_SOURCE_MEDIA` accepts `{ tabId, sourceOrigin }` from trusted extension UI and returns recent successful network playlists from that tab. The workbench button scans only while paused, then assigns `selected` and `job.playlist` together, clears `job.pending`, and resumes.

- [x] Add failing tests for a navigated source tab and for paused-job recovery with a replacement source.
- [x] Run targeted tests and confirm the expected failures.
- [x] Implement the validated message and recovery button with cancellation and clear errors.
- [x] Run targeted tests and confirm they pass.

### Task 4: Release verification

**Files:** Modify `manifest.json`, `package.json`, `README.md`, `TESTING.md`, `PRIVACY.md`; create release notes.

- [x] Explain the new recovery flow and its refusal cases in Chinese without real media URLs.
- [ ] Run all unit tests, UI smoke, syntax checks, package verification and `git diff --check`.
- [ ] Review the diff and publish a versioned GitHub package only if the verification is clean.
