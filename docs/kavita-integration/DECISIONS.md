# Readest × Kavita V1 Decisions

## D-001 — Readest-owned server identity

- Date: 2026-08-19
- Status: Accepted

Kavita v0.9.0.2 exposes its `installId` only through an Admin-policy
controller. Requiring it would contradict the non-admin, Auth-Key-only boundary.

Readest creates a random UUID (`serverId`) after the connection diagnostic
succeeds. The UUID is encrypted in replica sync with the Auth Key, never
presented as Kavita's `installId`, and is independent from device-local URL
overrides. Book IDs use `md5("kavita:" + serverId + ":" + chapterId)`.

Consequences:

- A server URL change does not alter existing book identity.
- Adding the same Kavita server as a separate connection intentionally creates
  a separate Readest source identity.
- Removing and recreating a connection creates new book identities unless the
  encrypted replica restores the original connection.

## D-002 — Extract shelf covers from authenticated EPUB ranges

- Date: 2026-08-19
- Status: Superseded by D-003

Kavita `v0.9.0.2` requires the real Auth Key in the `apiKey` query parameter of
its chapter-cover controller. An `x-api-key` header does not replace that query
value. Embedding the credential in a DOM image URL would expose it to URL logs,
history and diagnostics, contradicting the locked Auth-Key handling rules.

Readest therefore obtains Kavita shelf covers from the source EPUB through its
existing authenticated strict-Range transport and the unmodified foliate-js
`DocumentLoader`. Extracted covers are versioned by server, chapter, file ID,
size and creation timestamp, then persisted in the device-local Books area.

Consequences:

- Auth Keys never enter shelf-cover URLs; the Kavita image endpoint is unused.
- First display can require several Range requests, so work is viewport-lazy,
  concurrency-limited, deduplicated and cancellable.
- A successfully extracted cover remains available after an offline cold start.
- An unseen uncached book shows Readest's text fallback while offline.

## D-003 — Fetch shelf covers through Kavita's authenticated image API

- Date: 2026-08-19
- Status: Accepted

Readest Remote optimizes shelf loading by fetching
`/api/Image/chapter-cover` through its private transport layer. Kavita 0.9.x
requires the real Auth Key in the `apiKey` query parameter and uses the
`x-api-key` header for authentication, so the request contains both. The URL
is never persisted or assigned to a DOM image; only a validated Blob or an
application-managed cache entry crosses into the UI.

Consequences:

- A successful cold load uses one small cover request and no EPUB Range
  request.
- Windows, Android and Web share the same API-first behavior, subject to the
  browser's CORS, certificate and mixed-content restrictions.
- A device-global 1 GiB LRU cache is independent from EPUB Range cache and
  full offline books, uses 24-hour stale-while-revalidate, and contains no URL
  or credential material.
- EPUB cover extraction remains a single, classified fallback for compatible
  HTTP/response failures and for complete local offline EPUBs. Network, TLS,
  CORS, authentication, permission and rate-limit failures never bypass their
  boundary through remote Range requests.
