# Readest × Kavita V1 Benchmarks

## Catalog scan — 2026-08-19

Environment:

- Kavita `v0.9.0.2`
- Image digest:
  `sha256:880a8feff0833e860575f8e08788e4b4f59f8659afd17206566aae88a525130d`
- Read-only fixture: 715 EPUB files
- Account: non-admin with Login and Download roles
- Client and server: Windows host / local Docker Desktop network
- Page size: 50

Results:

| Pass | Elapsed | Series pages | Series | Volume requests | Imported single-file EPUB chapters |
| --- | ---: | ---: | ---: | ---: | ---: |
| Initial | 3482 ms | 3 | 148 | 148 | 675 |
| No-change | 3204 ms | 3 | 148 | 148 | 675 |

Forty fixture files were not imported because the locked V1 filter accepts
only Kavita chapters represented by exactly one EPUB file with a KOReader hash.
The benchmark only fetched catalog metadata; no EPUB response was requested.

## Range proof — 2026-08-19

- Representative chapter: `338`
- EPUB size: `792852` bytes
- First request: `bytes=0-1023` → `206`, exactly 1024 bytes
- Tail request: `bytes=791828-792851` → `206`, exactly 1024 bytes
- A separate explicit full download matched the source EPUB by SHA-256.

## foliate-js lazy-open proof — 2026-08-19

The browser integration test serves the checked-in 414345-byte Alice EPUB
through the same strict authenticated-Range seam used by Kavita and opens it
with the unmodified `DocumentLoader` from foliate-js. Metadata, navigation and
the first text chapter required two non-overlapping requests:

- `bytes=0-131071`
- `bytes=393216-414344`

Only 152201 bytes (36.7%) were received before the first chapter was available;
no response contained the full file. Existing foliate-js browser suites remain
the coverage for cross-chapter navigation, images, fonts, search, themes,
pagination and rendering behavior.

## Android native runtime — 2026-08-19

Environment:

- Android API 36 x86_64 emulator with ANGLE
- Readest debug APK built with SDK 36, NDK 28.2 and JDK 17
- Kavita `v0.9.0.2` reached through emulator host alias `10.0.2.2`

Results:

- Cold launch: `2305 ms`
- HOME/background hot restore: `219 ms`, same application process
- Catalog: the real 715-file Library connected and imported successfully
- Online open: foliate-js displayed page `1 / 307`; every observed chapter
  response was `206`, and the dedicated persistent Range cache reached
  `2.5 MiB`
- Offline transfer: `9,095,890` bytes, `100%`, no retry, final recorded speed
  `122,045 bytes/s`
- Offline restart: after Kavita was stopped and Readest was force-stopped, the
  book remained `Offline` and reopened to page `1 / 307`

## Android shelf-cover correction — 2026-08-19

The original shelf-cover request test did not decode an image and was replaced
with EPUB cover extraction over the authenticated strict-Range path.

On the affected 38-book series page, four covers were already persisted and
eight visible covers were absent. With a four-extraction concurrency limit and
a 50% viewport prefetch margin:

- the first measured 35-second window issued 24 `206` requests for four unique
  chapters;
- the following measured 60-second window issued another 15 `206` requests for
  four unique chapters;
- the complete server-log interval contained 61 `206` responses across those
  eight chapters, zero chapter `200` responses, and zero
  `/api/Image/chapter-cover` requests;
- all 12 visible covers decoded by the end of the 95-second observation, with
  eight newly extracted Blob URLs and four persisted asset URLs;
- after background cache completion, the eight chapter versions occupied
  11,678,805 bytes in 93 deduplicated 128 KiB-aligned cache records.

This run overlapped repository build/test load on the Windows host and is a
correctness/request-volume measurement, not a device-performance target. The
component test separately proves that an off-screen card makes no extraction
request until its intersection callback fires.
