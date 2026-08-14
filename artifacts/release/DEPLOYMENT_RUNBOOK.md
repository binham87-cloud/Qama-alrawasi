# R2 Production deployment runbook — DO NOT RUN IN THIS SESSION

Build: `qama-unified-final-2026-08-14.6-rc1`

**THIS SESSION MUST NOT DEPLOY, PUSH, MERGE, OR WRITE PRODUCTION DATA.**

Commands below are documented for a later owner-authorized window only.

## 1. Preflight (later)

- Confirm release archive SHA-256 matches this report.
- Confirm branch `recovery/qama-prod-2026-08-13.6` and the R2 commit.
- Confirm `index.html` and `public/index.html` are byte-identical.
- Confirm Firebase project `qama-alrawasi` and that no other deploy is in flight.

## 2. Backup / export (later — required)

```bash
# NOT TO BE RUN DURING R2 SESSION
# npm run backup -- --project qama-alrawasi
```

Keep the export off the deploy host. Record export timestamp.

## 3. Environment verification (later)

- Node 22 for Cloud Functions runtime.
- `firebase-tools` matching repo pin.
- Auth: PIN users exist; do not rewrite authPins from the client.

## 4. Rules / indexes first (later)

```bash
# NOT TO BE RUN DURING R2 SESSION
# firebase deploy --only firestore:rules,firestore:indexes --project qama-alrawasi
```

## 5. Functions (later)

```bash
# NOT TO BE RUN DURING R2 SESSION
# firebase deploy --only functions --project qama-alrawasi
```

## 6. Hosting (later)

```bash
# NOT TO BE RUN DURING R2 SESSION
# firebase deploy --only hosting --project qama-alrawasi
```

## 7. Migration

Default: **no production migration write**.

If a later owner decision requires classification application:

```bash
# NOT TO BE RUN DURING R2 SESSION
# node scripts/r2_migration_dry_run.mjs
# There is no authorized --write path in R2.
```

## 8. Post-deploy smoke (later)

- PIN list/login owner + one employee.
- BUILD_ID meta equals `qama-unified-final-2026-08-14.6-rc1`.
- Financial cards load from operationalReadModel.
- One pending request still pending (no surprise approvals).

## 9. Reconciliation verification (later)

Compare accountBalances to financialLedger replay. Investigate exceptions classified E; do not mint D rows.

## 10. Rollback criteria

- PIN login failure
- Financial cards zero/unsynced for an open month that previously loaded
- Duplicate collectionEvents for one operationId
- Negative accountBalances or custody

## 11. Rollback procedure

See `ROLLBACK.md`. Redeploy previous hosting+functions+rules from the last known-good archive (R1.3 `bc34d80` / BUILD `.5` if R2 is reverted).
