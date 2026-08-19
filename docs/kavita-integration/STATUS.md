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
| Phase 2 — connection and shelf sync | Pending | Library selection, staged pagination, and deletion safety |
| Phase 3 — reading, cache, offline | Pending | foliate-js lazy read, persistent LRU cache, verified offline transfer |
| Phase 4 — progress and credentials | Pending | Kavita-owned progress, encrypted credentials, conflict handling |
| Phase 5 — platform acceptance | Pending | Web, Windows, and Android runtime gates |

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

- None for Phase 2 implementation. The instance-identity API mismatch was
  resolved by the recorded `serverId` decision below.
- Web support remains conditional on Kavita CORS, HTTPS/mixed-content rules,
  certificate trust, and exposed Range headers.

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
