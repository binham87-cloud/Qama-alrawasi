# FINAL — Vacate/Holding production incident (2026-09-06)

## Verdict
Server vacate/close now **atomically reverses** live receipts before cancelling obligations. Holding matches space money. Deployed to `qama-new-prod-2026`. Stuck 177 repro repaired with documented opId. No remaining stuck live receipts.

## Root cause
Vacate called `setSpaceOccupancy` → `closeRentalInTx` which closed rental + cancelled unpaid obligations **without** reversing recognized cash. Holding kept counting the receipt.

## User 100
No live 100 at snapshot time. Failure mode proven by identical 177 repro on prod pre-fix. Historical 100 on ميزان 2/1 already reversed earlier.

## Repair
- Snapshot before: `VACATE-HOLDING-177-REPAIR-BEFORE.json` (holding 17700)
- `reverseReceipt` opId `repair-vacate-holding-177-mtp6trpe-reverse` on `rcpt:vacinc-cash-mtp6trpe`
- After: holding 0, receipt `reversed` — `VACATE-HOLDING-177-REPAIR-AFTER.json`

## Post-fix verification
- API 188 AED: collect → vacate → holding 0; double vacate; recollect once; vacate again — **9/9**
- UI manager 199: **6/6** (refresh + re-login + double vacate)
- Employee vacate 166: PASS
- Stuck scan: 0
- Integration tests: **45/45**

## Deploy
Hosting SHA `98766e8afa764132887597fc337db74902696e9b3dbc9d88617a8a6081299195` + functions update.
