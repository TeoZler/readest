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
| Phase 5 — platform acceptance | Reopened | The original reader/offline gates passed, but the later API-cover requirement exposed a missed visual defect and a still-failing Android cover-performance gate |
| Corrective API cover path | Functional pass; performance gate failed | API-first native Blob loading, device cache, retry/cooldown and classified EPUB fallback work on Android; cold first-cover and first-screen timings remain above the locked limits |

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

- Android API-first cover performance is not accepted. On the API 36 x86_64
  emulator the final isolated cold run decoded the first cover in `7711 ms`
  and only 11 covers within the 15-second observation window, versus the
  locked first-cover `1500 ms` / first-12 `5000 ms` limits.
  Functional evidence is clean (one image API GET per book, no EPUB Range or
  full-file response), but a functional pass does not waive the performance
  gate.
- The no-Release GitHub Actions matrix has not run. Apple, Linux, Windows
  ARM64, Android release signing, unsigned iOS packaging and KOReader/LuaJIT
  therefore remain CI-only hard gates.
- A stable Readest Remote Android release keystore and GitHub Secrets have not
  been created. This intentionally waits until the product owner can save the
  one-time recovery password and confirm it before any release attempt.
- Readest account/cloud login under the new callback identity has not been
  validated with an account. Google Drive is disabled unless a Remote-owned
  OAuth client is explicitly supplied; the fork no longer embeds or registers
  Readest's Google OAuth identity.
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

- Full unit regression passed: `717` files passed, `4` skipped; `9015`
  assertions passed, `16` skipped. Full browser regression passed: `37` files,
  `359` assertions passed, `1` skipped. The production Web build also passed.
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

## Corrective cover acceptance

The original Phase 5 acceptance missed a user-visible defect: it asserted the
shape of the chapter-cover request but did not require a real shelf image to
decode. Android therefore displayed generated text fallbacks for uncached
Kavita books even though the mocked request test passed.

The real Kavita `v0.9.0.2` contract proved that `/api/Image/chapter-cover`
requires the Auth Key as its `apiKey` query value. Supplying only the
`x-api-key` header returned `400`; a harmless query placeholder plus the header
returned `401`. Putting the real key in a cover URL would violate the locked
credential boundary, so Readest no longer uses that endpoint.

The corrected shelf path opens the chapter through the same authenticated,
strict-`206` `RemoteFile` used by foliate-js, extracts `book.getCover()`, and
persists `cover.png` with a source-version marker. It deduplicates concurrent
loads, caps extraction concurrency at four, cancels unused work, and starts
only when a card reaches the viewport or its 50% prefetch margin. A cold-start
credential unlock is deduplicated so covers do not race SecretStore startup.

Corrective evidence on 2026-08-19:

- A Chromium browser test served a real fixture EPUB through authenticated
  ranges, decoded the extracted Blob as an image, and asserted positive natural
  width and height. No request URL contained the test Auth Key and no response
  represented the complete file.
- On the Android API 36 emulator, the affected 38-book series page reached
  `12/12` decoded visible covers. Eight previously missing covers were extracted
  through 61 observed `206` responses for eight unique chapters; the Kavita
  image endpoint was called zero times and no other chapter response status was
  observed. Three rendered cards below the prefetch boundary remained pending
  until eligible.
- With Kavita stopped, a force-stop/cold-start loaded every previously persisted
  cover through `asset.localhost`; there were zero `blob:` network covers. Books
  whose covers had never been viewed continued to show the deliberate text
  fallback while offline.
- Full correction regression passed: lint/type check (`2034` files), unit
  (`9015` passed, `16` skipped), Chromium browser (`359` passed, `1` skipped),
  Rust (`89/89`), Windows Tauri WebDriver (`113` passed, `1` skipped), Web
  production build, Windows release `--no-bundle`, and the final Android x86_64
  debug build plus runtime inspection.

### API-first follow-up

The product owner subsequently accepted the performance tradeoff of placing
the Auth Key in Kavita's required image-controller query parameter, provided
the URL remains private to the transport layer. D-002 is therefore superseded
by D-003. The new implementation:

- sends the real key in both `apiKey` and `x-api-key`, then validates and
  decodes a maximum 16 MiB image Blob;
- limits work to six concurrent requests and the viewport plus a two-screen
  margin;
- retries transient responses three times, applies connection-level cooldown,
  and emits at most one authentication/permission notice per server;
- stores validated covers in a separate device-global `KavitaCoverCache`
  namespace with a default 1 GiB LRU budget and 24-hour revalidation;
- retains the old authenticated EPUB extraction only for the locked fallback
  matrix and complete local offline EPUBs.

Targeted implementation checks on 2026-08-19 and final regression on
2026-08-20:

- TypeScript type check: passed.
- Unit tests: cover retry/auth/304, persistent versioning/global LRU/clear, and
  BookCover lifecycle — `3` files, `12` assertions passed.
- Chromium browser test: the API request included both credential locations,
  returned a Blob that decoded with positive dimensions, and the existing
  strict-Range extraction fallback still decoded the real EPUB cover — `2`
  assertions passed.
- The native cover transport now owns the credential-bearing URL on Windows
  and Android, uses shared strict/insecure HTTP clients, returns only redacted
  error classes across IPC, bounds responses at 16 MiB, decodes/rasterizes the
  image and returns a small JPEG Blob. Cancellation is wired through a native
  request registry, and aborted concurrency waiters no longer strand a slot.
- Full unit regression passed `723` files with `9039` assertions; `4` files and
  `16` assertions were skipped. Full Chromium regression passed all `37` files
  with `360` assertions and `1` skipped. TypeScript/Biome lint passed (`2043`
  files), and all `89` Rust library tests passed.
- The global Manage Cache dialog now counts and clears `KavitaCoverCache`
  entries as well as the existing caches, while leaving complete offline EPUBs
  untouched. Android runtime inspection confirmed the count/size increase and
  the subsequent clear.
- Android functional acceptance reached `12/12` decoded visible covers. The
  native probe observed no credential-bearing URL in WebView/CDP, Kavita logs
  showed one chapter-cover GET per unique book, and no `/api/Download`, EPUB
  Range fallback or full EPUB response occurred on the success path.

The former Range-extraction Android measurements are historical evidence, not
acceptance evidence for D-003. For the final isolated API-first run, the shelf
was first switched to local-only, `KavitaCoverCache` was removed while the app
was stopped, and the process was cold-started before switching to the Remote
source under the probe. The first Blob cover decoded in `7711 ms`; only 11
decoded within 15 seconds, so the first-12 result did not reach the locked
`5000 ms` gate. Native metrics showed response/network time as the dominant
cost (up to about `8.0 s` for an individual request), while Base64 decode was
`0–4 ms` for the measured completions. A fresh Windows API-first cover
benchmark also remains mandatory before release.

## Readest Remote release identity

The distribution identity is now `Readest Remote` `0.12.1-r1`, with executable
`readest-remote`, application identifier `io.github.wenhe233.readestremote`,
and custom schemes `readest-remote://` and `readest-remote-onedrive://`.
Internal workspace package names, the `Readest` Cargo crate, database and sync
protocols, and `/Readest/...` storage layout remain unchanged.

Identity evidence on 2026-08-19 and final isolation verification on
2026-08-20:

- The Android x86_64 APK built and its binary manifest reports package
  `io.github.wenhe233.readestremote`, version name `0.12.1-r1`, version code
  `12001001`, label `Readest Remote`, no Billing permission, no upstream App
  Link, and only the new Remote custom schemes.
- The final universal release resources were rebuilt with the already-verified
  arm64/x86_64 release libraries, test-signed solely for local installation,
  and installed over the emulator test build. Binary inspection again reported
  `io.github.wenhe233.readestremote`, `12001001`, `0.12.1-r1`, label
  `Readest Remote`, and no upstream Google/App Link scheme.
- The API 36 emulator has both `com.bilingify.readest` and
  `io.github.wenhe233.readestremote` installed. Android resolves `readest://`
  only to the official package and `readest-remote://` only to Remote. Their
  data directories are distinct, and Remote cold-started with an empty library
  instead of inheriting the official test library.
- The Windows x64 release and NSIS bundle build successfully after mapping the
  Windows-internal prerelease to numeric `0.12.1-1`; package/UI/Release identity
  remains `0.12.1-r1`. PE resources report `Readest Remote`, and the native
  binary is `readest-remote.exe`.
- Official Readest `0.12.1` and Remote were installed side by side under
  `C:\Program Files\Readest` and `C:\Program Files\Readest Remote`. Their
  uninstall entries and roaming/local data roots are distinct. A live protocol
  probe launched the official binary for `readest://` and the Remote binary for
  `readest-remote://`.
- Side-by-side inspection caught and removed two remaining collision sources:
  the Remote bundle no longer builds/bundles the Explorer thumbnail DLL, no
  longer registers Readest's Google reverse-DNS callback, and uses
  `Readest Remote ...` ProgIDs plus Remote-owned custom Apple content types for
  file associations.
- The final NSIS was installed, silently uninstalled, and installed again next
  to official Readest. Installation mapped `.epub` to the Remote-owned
  `Readest Remote EPUB Document` ProgID without changing the official
  `readest://` handler. Remote uninstall removed only its protocol/ProgID,
  restored `.epub` to official `EPUB Document`, left official Readest intact,
  and the final reinstall restored the verified side-by-side state.
- The Web production build passed. Final full Vitest regression passed `723`
  files and `9039` assertions, with `4` files and `16` assertions skipped.
  Final Chromium regression passed `37` files and `360` assertions with `1`
  skipped. TypeScript and Biome lint passed (`2043` files); scoped rustfmt,
  all `89` Rust library tests, and Clippy with warnings denied passed. Clippy's
  sole required allowance is `clippy::incompatible-msrv` in the pinned Tauri
  source, which declares Rust `1.77.2` while using `repeat_n` stabilized in
  Rust `1.82.0`; no product-code warning was suppressed.
- Calibre regression passed `113` tests and maps the Remote revision to
  `PLUGIN_VERSION = (0, 12, 1, 1)`. The browser extension built and produced a
  reproducible, system-zip-independent
  `Readest-Remote_0.12.1-r1_browser-extension.zip` whose manifest displays
  `Send to Readest Remote`.
- Apple main app, Share Extension, Widget, App Group, Keychain service and
  iCloud container use the new identifier family. The upstream development
  team, App Link entitlement, and purchase entitlement are absent. Apple
  compilation remains a CI/macOS gate.
- The upstream update endpoints and public key are absent, the updater plugin
  is not registered, purchase UI is disabled, and telemetry initializes only
  from explicitly supplied Remote-owned environment variables.

## Readest Remote release workflow

The release pipeline now has separate test, platform-build, aggregation and
publication gates. A manual `workflow_dispatch` builds and uploads the complete
matrix without creating a GitHub Release. A `v*` tag must exactly match the
package version and creates the formal Release only after every required job
and the 16-file artifact manifest succeed.

Release-pipeline evidence on 2026-08-19:

- `actionlint 1.7.12` passed all retained workflows. The workflow pins the
  validator container by digest and all GitHub Actions by commit.
- Full TypeScript/Biome lint passed (`2039` files). Full Vitest regression
  passed `721` files and `9032` assertions, with `4` files and `16` assertions
  skipped. Four additional release tests reject missing, empty, unexpected or
  updater artifacts and prevent dispatch runs from publishing a Release.
- The downloadable Web build completed as a real static export under webpack,
  with the `Readest Remote` PWA identity and a non-empty `sw.js`. It does not
  ship browser source maps. The 6 GiB Node heap limit is explicit so this build
  is not dependent on the runner's default heap size.
- Windows setup and portable artifacts are distinct builds. The portable pass
  compiles with `NEXT_PUBLIC_PORTABLE_APP=true`; it is not a renamed copy of
  the installed-mode binary.
- Android Gradle tests completed all configured ABI/flavor tasks (`851`
  actionable, `604` executed). Release signing accepts separate store and key
  passwords while retaining the old single-password format for local
  compatibility. CI verifies both APKs against the pinned certificate digest,
  package ID, version code/name, label and absence of Billing permission.
- The browser extension rebuilt and produced
  `Readest-Remote_0.12.1-r1_browser-extension.zip`. Local KOReader packaging is
  still blocked by the Windows host's missing `zip`/LuaJIT and remains a CI
  hard gate.
- Official nightly/updater, R2 upload, Vercel production deployment and legacy
  `ghcr.io/.../readest` publication workflows were removed. The new release
  never produces updater signatures or `latest.json`.
- Aggregation requires the exact Windows x64/ARM64, Linux x64/ARM64, macOS
  universal, Android universal/ARM64, unsigned iOS ARM64, Web, KOReader,
  Calibre and browser-extension filenames, then generates and re-verifies
  `SHA256SUMS.txt` from the assembled directory.

Remaining hard gates before the release tag:

- Meet the API-first cover timing limits on Android and run the corresponding
  fresh Windows benchmark. The current Android functional result is not fast
  enough to accept.
- Run the KOReader syntax/tests in CI or another environment with LuaJIT; the
  Windows host has no LuaJIT and the local scripts therefore reported a skip.
- Run Apple, Linux ARM64/x64, Windows ARM64, Android release-signing and iOS
  unsigned-IPA jobs in the no-Release Actions matrix.
- Generate the stable Remote Android keystore only after the product owner can
  save and confirm the one-time recovery password, then configure the release
  Secrets and prove an upgrade signed by that certificate.
- Validate account/cloud login with an account under the new callback identity;
  Google Drive stays disabled until a Remote-owned OAuth client is supplied.
