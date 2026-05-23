# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project layout

Cross-browser (Chrome MV3 + Firefox MV3) extension built with **WXT + React 19 + TypeScript**.

- `app-v3/` — all active source. Run all `npm` commands from here.
- `KEEP-DO-NOT-DELETE/` — frozen v1 codebase kept only for migration reference. **Never modify.**
- `build.ps1` — root build wrapper (PowerShell) that just `cd`s into `app-v3` and runs `npm run build`.

## Commands

Production build (Chrome, from repo root):

```powershell
.\build.ps1
```

Direct WXT commands (from `app-v3/`):

```powershell
npm run dev             # Chrome dev + HMR (options page only)
npm run dev:firefox     # Firefox dev
npm run build           # Chrome production build → .output/chrome-mv3/
npm run build:firefox   # Firefox production build → .output/firefox-mv3/
npm run zip             # Build + zip for store upload
npm run compile         # TypeScript type-check only (tsc --noEmit) — no test suite exists
npm run icons           # Regenerate PNG icons from source
npm run verify:version  # Asserts package.json version matches built manifest.json
```

Load unpacked: `app-v3/.output/chrome-mv3/` (Chrome) or `.output/firefox-mv3/manifest.json` (Firefox via `about:debugging`).

## Architecture

Three runtime contexts communicate via Chrome messaging:

```
entrypoints/background.ts (service worker)
  ├─ browser.alarms          → runScrape()      (utils/scraper.ts)
  └─ browser.runtime.onMessage → manualScrape | settingsUpdated
                              ↓
utils/scraper.ts :: runScrape()
  ├─ per target: tabs.create (hidden) → waitForTabComplete → scripting.executeScript
  │  ├─ Phase 1 (inline func): poll up to 10s for job cards OR Cloudflare marker
  │  └─ Phase 2 (file inject): content-scripts/upwork-scraper.js → returns ScrapeResult
  └─ processTargetResult → storage write → webhook POST → notifications
                              ↑
entrypoints/upwork-scraper.content.ts  (runtime-registered, NOT in manifest)
```

Key invariants — do not violate without strong reason:

- **Content script is runtime-registered** (`registration: 'runtime'`), injected via `scripting.executeScript({ files: ['content-scripts/upwork-scraper.js'] })`. It is intentionally absent from the static manifest.
- **Scrape phase runs in parallel** with `TARGET_CONCURRENCY = 2`; **post-process is strictly sequential** because `seenJobIdsStorage` / `jobHistoryStorage` / activity logs are read-modify-write on shared storage and would race otherwise (`scraper.ts:710`, `runScrape` loop comment).
- **Tab URL match is origin-only**, not pathname-strict. Upwork bounces through Cloudflare challenges and login redirects before settling; strict pathname matching previously caused 60s timeouts (`scraper.ts:271`).
- **Tab load timeout retries once** after `TAB_TIMEOUT_RETRY_DELAY_MS = 7000` (`scrapeTargetWithRetry`).
- **Alarms use jittered delay** (`±30s`, min 0.5 min) and re-arm in the `.finally()` of every alarm fire to keep cadence stable.

## Storage (`app-v3/utils/storage.ts`)

Always go through the typed WXT wrappers — never call `browser.storage` directly.

| Wrapper | Backing key | Notes |
|---|---|---|
| `settingsStorage` | `sync:settings` | Synced; pass results through `sanitizeSettings()` after every read |
| `seenJobIdsStorage` | `local:seenJobIds` | Dedup set keyed on `Job.uid` |
| `jobHistoryStorage` | `local:jobHistory` | Capped at `JOB_HISTORY_MAX = 100`, newest first |
| `webhookFailureCountsStorage` | `local:*` | Consecutive-failure counter per target.id |
| `webhookErrorsStorage` | `local:*` | Last error message per target.id |
| `activityLogsStorage` | `local:*` | Ring buffer for the Activity page (appendActivityLog) |

After 3 consecutive webhook failures for the same target, a "Webhook Delivery Error" notification fires (`WEBHOOK_FAILURE_NOTIFICATION_THRESHOLD`).

## Types (`app-v3/utils/types.ts`)

Single source of truth for `Job`, `Settings`, `SearchTarget`, `ScrapeResult`, `WebhookJob`, `LegacyWebhookJob`, `MessageType`, `ActivityLog`. Import from `../utils/types`; never redeclare inline.

`MessageType` is a closed union with exactly two shapes:

```ts
| { type: 'manualScrape' }
| { type: 'settingsUpdated' }
```

Both handlers in `background.ts` must `return true` from `onMessage` to keep the async channel open.

## Webhook payload contract

Per-target `payloadMode` toggles between two shapes (full schema in `README.md` "Webhook payload contract"):

- `v3` (default for new targets) — `{ status, targetName, jobs, timestamp }` envelope
- `legacy-v1` (default for v1-migrated targets) — flat array compatible with 1.x automations

Issue payloads (`captcha_required | logged_out | error`) are sent only when `webhookEnabled && webhookUrl`. `no_results` is **not** sent to webhook. `is4xxStatus()` suppresses Sentry capture for 4xx (target misconfigured = user error, not extension bug).

Posted-time has three fidelity tiers ranked by `getPostedSourceRank`: `upwork_absolute` > `relative_estimate` > `fallback_scraped_at`. When backfilling history, only overwrite `postedAtMs`/`postedAtSource` with strictly higher-fidelity data.

## DOM parsing quirks

- **Upwork has a typo in their own HTML**: the published-date attribute is `data-test="job-pubilshed-date"` (misspelled). The scraper relies on this — do not "fix" it.
- Job tiles selector: `article[data-ev-job-uid]`. Absence + visible login link → `ScrapeResult { ok: false, reason: 'logged_out' }`.
- Cloudflare detection: `Cloudflare Ray ID` text or `cloudflare` + `verify you are human|security check`. If detected without job cards within 10s → `captcha_required`.

## Versioning

Single source of truth: `app-v3/package.json` `"version"`. WXT propagates it to `manifest.json` at build — **never edit the built manifest**.

After any code change in `app-v3/`, bump semver:
- `patch` — bug fix, copy/style tweak
- `minor` — new non-breaking behaviour
- `major` — breaking change

`npm run verify:version` checks package.json vs the produced manifest.

## Conventions

- Inline styles via `React.CSSProperties` objects. UI uses `@radix-ui/themes` + `@radix-ui/react-icons`. No CSS modules, no Tailwind.
- `browser.*` is provided as a global by WXT in `entrypoints/` and `utils/` — no import needed.
- MV3 permissions live in `wxt.config.ts` `manifest()` block, not a hand-written manifest file.
- Settings save flow is fixed: update local state → `settingsStorage.setValue()` → `sendMessage({ type: 'settingsUpdated' })`. The message is what re-arms the alarm.
- Console logs are prefixed `[Upwork Scraper]`.
- Sentry context wrappers: `initSentryContext(scope)`, `captureContextException(scope, err, extras)`. All scrape/webhook error paths already route through these.

## Sentry (v3)

Initialised in all three runtime contexts (background, content script, options page).

Runtime env vars (read by extension code at build, baked into bundle):
- `WXT_SENTRY_DSN` (required for events to be sent)
- `WXT_SENTRY_ENVIRONMENT`, `WXT_SENTRY_RELEASE`, `WXT_SENTRY_TRACES_SAMPLE_RATE`, `WXT_SENTRY_ENABLE_LOGS`

Build-time env vars (sourcemap upload only, optional locally):
- `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`
- `SENTRY_SOURCEMAPS=true` to emit hidden sourcemaps
- `SENTRY_UPLOAD_SOURCEMAPS_VITE=true` to enable the Vite plugin upload path

## CI / release

- `.github/workflows/ci-validate.yml` — runs on PRs; builds Chrome + Firefox.
- `.github/workflows/release-publish.yml` — runs on push to `main`; gated by GitHub `production` environment (manual approval). Uploads ZIPs to GitHub release, sourcemaps to Sentry, packages to CWS + AMO (upload-only — final publish is manual in each store dashboard).
- Release tag pattern: `v<package-version>-main.<run-number>`.

### Known release-pipeline gotchas

- **Bump `app-v3/package.json` version before every push to `main`.** AMO (`web-ext sign`) rejects re-uploads of an existing version with HTTP 409 `Conflict — Version X already exists`. WXT propagates this version into the built manifest; `package-lock.json` top-level `version` should be bumped to match (only the two project-level entries at the top, not transitive dep `3.3.x` strings).
- **CWS allows only one pending submission per item.** While an extension is in manual review at the Chrome Web Store, any new upload to the same item returns HTTP 400 (`ITEM_PENDING_REVIEW` / `ITEM_NOT_UPDATABLE`). The release workflow's `Upload to Chrome Web Store (upload-only)` step will fail with `curl: (22) ... error: 400` until the previous submission is approved or rejected. The workflow currently uses `curl --silent --fail`, which hides the actual response body — when debugging, drop `--silent` (keep `--show-error`) to see the CWS error JSON.
- AMO does NOT have this limitation — it queues new versions during review.

## Reference docs to consult before non-trivial changes

Per `.github/copilot-instructions.md`: use `context7` MCP for current docs on WXT, React, TypeScript before writing new code that touches those APIs — training data may lag.
