# Controlled August Reconstruction — Cutover and Rollback

## Pre-activation sequence

1. Obtain explicit deployment/cutover authorization.
2. Freeze Legacy financial writes without modifying evidence.
3. Export, inventory, timestamp, and hash current Legacy August and structural sources; store immutable evidence separately from canonical financial collections.
4. Review which units, tenancies, cycles, obligations, due dates, users, and roles are independently proven.
5. Deploy only the reviewed build under a separately approved release.
6. Create one staged reconstruction plan referencing the snapshot hashes. Do not activate it.
7. Authorized employees re-enter actual business events through canonical commands with original effective dates and source references.
8. Managers complete every normal approval.
9. Run completeness, duplicate, custody, allocation, ledger replay, Rules, role, and projection audits.
10. Present calculated canonical results and record-level Legacy differences for owner review; never force totals to match.
11. Atomically activate the single canonical reconstruction authority only if all blockers are zero and Legacy projection is zero.
12. Verify first post-cutover synthetic/controlled behavior and keep Legacy evidence read-only.

## Rollback conditions

Stop or roll back before activation for any missing snapshot hash, unproven structural identity, duplicate reference, pending approval, unresolved payment, invalid custody, deposit exceeding eligible custody, date/month mismatch, ledger/balance mismatch, active Legacy projection, direct-client write path, idempotency/concurrency failure, PIN/role regression, or mismatch between projection and drill-down.

Before activation, cancellation returns authority to Legacy without deleting reconstructed audit evidence. After activation, do not re-enable simultaneous Legacy financial projection. Enter maintenance mode and use reviewed compensating events or audited replay/repair.

This document is planning only; no Production action was performed.
