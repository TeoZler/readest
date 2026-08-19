# Readest × Kavita V1 Status

This document is the execution log for the Kavita V1 integration. It records
hard gates, reproducible checks, and known blockers. Secrets and local Kavita
test infrastructure must never be added to this repository.

## Locked baseline

- Readest: `v0.12.1` / `f3e1df7e0572c0119cbb420e1e27ca9af859f91c`
- foliate-js: `f65836f77e8b66b84baacd54bfc92096578e7a84`
- Kavita minimum: `v0.9.0.2`
- Feature branch: `feat/kavita-v1`
- Integration worktree: `readest-bootstrap-kavita-v1`
- Original `main` worktree remained clean throughout bootstrap.

## Phase status

| Phase | Status | Gate evidence |
| --- | --- | --- |
| Phase 0 — isolated baseline | Complete | Exact SHAs verified; submodules synchronized; `pnpm install --frozen-lockfile` passed |
| Phase 1 — API and range proof | Complete | Non-admin Auth Key authentication, supported version, Library access, exact `206` Range, and original-file proof passed |
| Phase 2 — connection and shelf sync | Complete | Connection UI, explicit Library selection, staged pagination, source filters, and deletion safety |
| Phase 3 — reading, cache, offline | Complete | Strict lazy foliate-js open, persistent LRU cache, verified queued offline transfer |
| Phase 4 — progress and credentials | Complete | Kavita-owned progress, encrypted credentials, conflict handling and offline queue |
| Phase 5 — platform acceptance | Complete | Full Web/Windows/Android checks and real Android Kavita runtime acceptance passed; Web remains explicitly conditional |

## Phase 0 verification

Run from the integration worktree root:

```text
pnpm install --frozen-lockfile
pnpm --filter @readest/readest-app setup-vendors
pnpm lint
pnpm test -- --run
```

Results on 2026-08-19:

- lint: passed (`1992` files checked)
- unit tests: `706` files passed, `4` skipped
- assertions: `8952` passed, `16` skipped
- Android prerequisites installed: Android SDK 36, Build Tools 36.0.0,
  platform-tools 37.0.1, emulator 37.1.11, NDK 28.2.13676358, and the
  Android 36 Google APIs x86_64 system image

## Current blockers

- No Readest V1 implementation or native-platform blocker remains.
- Positive Web connectivity to an unmodified Kavita `v0.9.0.2` production
  server is unavailable: real catalog and Range preflights returned `204`
  without `Access-Control-Allow-Origin` or allowed/exposed header fields. This
  is the documented conditional-Web boundary; Readest classifies and explains
  it instead of adding a private-network proxy or weakening browser security.

## Phase 1 real-server evidence

Tested on 2026-08-19 against the pinned
`ghcr.io/kareadita/kavita@sha256:880a8feff0833e860575f8e08788e4b4f59f8659afd17206566aae88a525130d`
image with a non-admin account holding Login and Download roles:

- Auth Key plugin authentication returned Kavita `0.9.0.2`.
- The read-only 715-file fixture was indexed as 148 series over 8 pages.
- Chapter `338` reported `792852` bytes.
- `bytes=0-1023` returned `206`, `Content-Range: bytes 0-1023/792852`,
  and exactly 1024 bytes.
- `bytes=791828-792851` returned `206`,
  `Content-Range: bytes 791828-792851/792852`, and exactly 1024 bytes.
- A separate, explicit full download matched the source EPUB by SHA-256.
- `server-info-slim` returned `403` to the non-admin user and succeeded for the
  administrator, confirming an authorization boundary rather than a transport
  failure.
- Phase 1 targeted tests passed (`8` files, `48` assertions), and repository
  lint/type checking passed (`2018` files checked).

## Accepted identity decision

On 2026-08-19 the product owner selected a Readest-owned random UUID named
`serverId`. It is created on first successful connection, encrypted alongside
the Auth Key in credential replica sync, and remains stable when a device uses
a URL override. It is explicitly not Kavita's admin-only `installId`. Kavita
book identity is therefore `md5("kavita:" + serverId + ":" + chapterId)`.

## Phase 2 verification

- Connection management is available under Integrations → Kavita, including
  classified diagnostics, explicit Library multi-selection, device URL
  overrides, native-only invalid-certificate opt-in, immediate sync, and typed
  server-name removal confirmation with affected-book/offline-size totals.
- Catalog pages persist additions and metadata updates incrementally. Existing
  rows are removed only after every selected Library page and volume request
  succeeds; a failed later page cannot delete rows. Full offline copies become
  orphaned instead of disappearing.
- Kavita books carry source and availability badges and can be filtered by
  local source, Kavita server, or Kavita Library.
- Kavita rows and files are excluded from Readest Cloud and third-party file
  sync. Only the encrypted connection replica participates in account sync.
- Startup, foreground-after-15-minutes, network recovery, pull-to-refresh, and
  explicit sync triggers are wired without reader polling.
- Real 715-file catalog benchmark: 148 series over 3 pages at page size 50;
  675 supported single-file EPUB chapters. Initial scan was 3482 ms and the
  no-change scan was 3204 ms. See `BENCHMARKS.md`.
- Targeted regression: `51` test files and `383` assertions passed; repository
  lint and type checking passed (`2024` files checked).

## Phase 3 verification

- Kavita EPUBs open through the existing foliate-js `DocumentLoader`; the
  authenticated `RemoteFile` path rejects HTTP `200` Range rewrites and keeps
  128 KiB aligned reads cancellable, deduplicated and retry-limited.
- Browser lazy-open proof loaded metadata, navigation and the first text
  chapter from a 414345-byte EPUB using two requests and 152201 bytes (36.7%),
  with no full-file response. See `BENCHMARKS.md`.
- The persistent cache uses a Kavita-only IndexedDB namespace, versioned keys,
  configurable per-server limits and LRU eviction. Real Chromium tests cover
  exact hits, version invalidation and eviction.
- Full offline EPUBs use the existing transfer queue for progress, cancellation
  and retry; temporary files are size-checked and parsed as EPUB before atomic
  promotion. Failure removes the partial file, and server deletion removes
  offline copies plus the server cache after typed-name confirmation.
- Targeted Phase 3 regression passed (`4` test files, `21` assertions), browser
  tests passed (`2` files, `3` assertions), and repository lint/type checking
  passed (`2033` files checked).

## Phase 4 verification

- Kavita books bypass Readest Cloud, KOSync, BookOrbit progress and every file
  backend progress writer. Their only remote progress owner is the source
  Kavita connection.
- The reader pulls on open, writes with a five-second debounce, flushes on
  background/close, and uses the chapter KOReader hash with a Kavita-compatible
  `DocFragment[n]` plus overall percentage. Server-level policies support ask,
  prefer-local and prefer-Kavita behavior.
- Offline progress is device-local and coalesced per book. Reconnect reads the
  server timestamp first and drops a stale queued write when another device has
  newer progress.
- Real Kavita `GET → PUT → GET` with the non-admin Auth Key returned `200`,
  applied `DocFragment[2]`, reported positive percentage and timestamp, and the
  original test position was restored with another `200` PUT.
- The Readest-owned `serverId` and Auth Key remain encrypted replica fields
  behind the Credentials toggle. Native storage uses SecretStore; the browser
  AES-GCM test verifies an unextractable key, 12-byte IV, ciphertext-only
  IndexedDB record, and warned session-only fallback.
- Targeted Phase 4 regression passed (`3` files, `11` assertions), the browser
  credential suite passed (`1` file, `2` assertions), and repository lint/type
  checking passed (`2033` files checked).

## Phase 5 verification

- Full unit regression passed: `717` files passed, `4` skipped; `9012`
  assertions passed, `16` skipped. Full browser regression passed: `36` files,
  `358` assertions passed, `1` skipped. The production Web build also passed.
- Browser acceptance covers allowed CORS, preflight rejection, HTTPS mixed
  content, missing Range exposure, a proxy-rewritten `200`, AES-GCM credential
  storage and quota failures. Against the real pinned Kavita server, both the
  catalog preflight (`x-api-key`) and chapter preflight (`range,x-api-key`)
  returned `204` without CORS allow headers, and the conditional-support
  diagnostic rejected the connection as designed.
- Rust acceptance passed `89/89` tests, formatting, and clippy with warnings
  denied. Windows Tauri WebDriver passed `113` tests with `1` skipped; the
  production `tauri build --no-bundle` produced `target/release/readest.exe`.
- The Android x86_64 debug APK built with SDK 36, NDK 28.2 and JDK 17, installed
  in the API 36 emulator, and passed all `16/16` Android CDP/ADB tests. The
  Windows-hosted Android cross-build uses a vendored `turso_ext 0.6.1` whose
  build script reads Cargo target metadata, preventing the host-only
  `advapi32` link flag from leaking into Android; runtime source is unchanged.
- Real Android native HTTP connected to `http://10.0.2.2:5001` with the
  non-admin Auth Key, validated Library/download access and a representative
  `206`, selected the fixture Library, and imported the 715-file catalog. Cold
  start took `2305 ms`; a HOME/background hot restore retained the process and
  returned in `219 ms`.
- Opening a 9,095,890-byte Kavita EPUB displayed foliate-js page `1 / 307`
  while Kavita served only `206` chapter ranges. The device reported `2.5 MiB`
  in the dedicated Range cache. A queued offline download then reached 100%,
  size-checked and trial-opened the EPUB, and marked it `Offline`.
- With the Kavita container stopped, Readest was force-stopped and cold-started.
  The offline book remained on the shelf and opened again to foliate-js page
  `1 / 307` while the server state stayed `exited`. The server was restored to
  healthy after the test.
