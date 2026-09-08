# QAMA

Rent collection for a multi-tenant residential building. Arabic, mobile-first, built so that
**money is the source of financial truth and status is derived from money** — never the reverse.

This is a new system. The legacy QAMA is untouched, unmigrated and unaffected.

## The one rule

There is no writable field anywhere that asserts a financial outcome. `Paid`, `Remaining`,
`Status`, `Holding`, `Collected`, `Deposited` and `Arrears` are all computed from financial
events. A client sending `status: "collected"` is rejected — the field does not exist in any
command schema.

## Run it locally

```bash
npm test                 # 60 tests, no emulator needed, ~2s

npm install --prefix functions
npm run emulators        # Firestore + Auth + Functions + Hosting + UI

# in a second terminal
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
export GCLOUD_PROJECT=qama-new
npm run seed             # demo building, refuses to run outside the emulator

open http://127.0.0.1:5000
```

Demo PINs: سعيد `1325` (owner) · يحيى `6477` · نادر `2026`. Change them before real use.

## Layout

```
src/domain/finance.mjs        every financial rule — pure, no I/O, no clock
functions/commands/index.mjs  the only write path: authz, schemas, idempotency, transactions
functions/auth/               server-side PIN verification (scrypt)
functions/repositories/       Firestore behind a small facade
functions/services/           read model — derived, never authoritative
functions/index.mjs           three callables: login · command · read
src/frontend/                 mobile client: renders, never calculates money
rules/firestore.rules         clients read what their role permits; clients write nothing
tests/                        domain · integration · security · concurrency
```

## Before production

See `RELEASE-READINESS.md`. Short version: create a **new** Firebase project on the Blaze
plan, fill `src/frontend/config.mjs`, deploy Rules and Functions, create real users with real
PINs, then run the acceptance checklist on a real phone.

## Documents

`FINANCIAL-MODEL.md` · `SECURITY.md` · `TEST-REPORT.md` · `RELEASE-READINESS.md` ·
`NEW-QAMA-FINAL-REPORT.md`
