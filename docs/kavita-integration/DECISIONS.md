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
