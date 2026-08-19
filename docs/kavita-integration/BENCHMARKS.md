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
