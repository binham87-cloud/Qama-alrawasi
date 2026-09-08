# Security

## Trust boundary

The browser is untrusted. It renders and dispatches; it computes no financial value and
writes no document. Firestore Rules deny **all** client writes to every collection, so the
only way state changes is a callable command executed with the Admin SDK.

## Authentication

PIN → server → custom token.

- PINs are stored only as scrypt hashes with per-user salts (`users.pinHash`, `pinSalt`).
- Rules deny client reads of `users` entirely, so hash material never leaves the server.
- Verification compares in constant time and checks every candidate, so neither the result
  nor the timing reveals which user matched.
- Five failed attempts per device per 15 minutes, then refusal. Failures are audited; the
  attempted PIN is never recorded.
- The custom token carries **identity only**. Role is re-read from the database on every
  single command, so a client that claims a role is simply ignored.
- Sessions persist up to 30 days (D5); sign-out or deactivation ends them.

## Authorization

Enforced in `functions/commands/index.mjs` before any domain call:

1. verify token → uid  2. load user, reject if missing or inactive
3. check `PERMISSIONS[command]` against the stored role
4. validate the payload against a strict schema
5. idempotency check  6. domain + persist in one transaction  7. audit in the same transaction

A test asserts that every command has both a schema and a permission entry, so no command can
be added with implicit access.

## Unknown fields are rejected, not stripped

This is the mechanism that makes the core rule enforceable. `status`, `role`, `collectorUserId`,
`employeeId`, `approvedBy`, `paidFils`, `holdingFils` are not accepted by any schema, so a
crafted request fails with `UNKNOWN_FIELD` and produces no partial effect.

Identity is taken from the authenticated actor, never the payload: a cash receipt's collector
is the caller, and a deposit draws on the caller's own custody.

## Hostile-client tests

`tests/integration/system.test.mjs` (S1–S9) covers: employee calling owner-only commands ·
role in payload · depositing another employee's custody · forging collector, state or
approvedBy · disabled account with a valid identity · unknown command · float money ·
PIN hashing and rate limiting · permission-matrix completeness.

## Known limitation

Rules are defence in depth, not the primary control, and they have **not** been executed
against the Firestore emulator in this build. See TEST-REPORT.md.
