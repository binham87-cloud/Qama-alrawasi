# Continuation note — 2026-09-06 VACATE/HOLDING INCIDENT — CLOSED

**Live:** https://qama-new-prod-2026.web.app  
**Hosting SHA256:** `98766e8afa764132887597fc337db74902696e9b3dbc9d88617a8a6081299195`  
**Functions:** deployed with atomic vacate reverse (same deploy wave)

## Root cause
`closeRental` / `setSpaceOccupancy(vacant|staff)` closed the rental and cancelled **unpaid** obligations only. It did **not** reverse recognized cash receipts. Shared Holding = Σ recognized cash − deposits, so holding stayed up while the space looked فارغ and monthly target dropped to 0 (closed rental excluded from KPIs).

**Mode:** reverse was never executed on vacate (not a holding-calc bug; not a UI-only paint). Proven pre-fix on prod with 177 AED.

## User 100 AED
At investigation start, **no live recognized 100** remained (holding 0). Closest historical 100: `rcpt:pay-rental:rentnew-44353e6fa_53472a4cb8b3_…` on **ميزان 2 / 1** (`mig:space:space:legacy:abccab24ba324cd72257f84b`), collector `mig:user:owner:saeed`, already `reversed` via uncollect then staff. Symptom matches the proven vacate-without-reverse failure mode (see 177 repro).

## Evidence / repair
| Item | ID / value |
|------|------------|
| Pre-fix repro receipt | `rcpt:vacinc-cash-mtp6trpe` (17700 fils) — stayed `recognized` after vacate; holding 177 |
| Repair opId | `repair-vacate-holding-177-mtp6trpe-reverse` → state `reversed`; holding 177→0 |
| Post-fix verify 188 | stamp `mtp6xrgo` — 9/9 PASS |
| UI manager 199 | `prod-vacate-ui-verify.json` — 6/6 PASS |
| Employee vacate 166 | holding +166 then 0; reversed `rcpt:empvac-cash-mtp71qky` |
| Stuck live scan after repair | **0** (`STUCK-LIVE-RECEIPTS-SCAN.json`) |
| Orphan obligations cancelled | 4 (`ORPHAN-OBLIGATIONS-*.json`) |

## Fix
- Server: `reverseLiveReceiptsForRental` inside `closeRentalInTx` (idempotent `rev:{operationId}:{receiptId}`), then cancel obligations ignoring just-reversed ids.
- UI belt: `maybeUncollect` also runs on vacant/staff.

## Tests
- `system.test.mjs` + `vacancy_clean_reset_regression` — **45/45**
- Live API verify 188 — **9/9**; UI — **6/6**; employee vacate — PASS

## Remaining
**Nothing** for this incident. Stop.

## Commit
`a988f1c` — Fix vacate/close to reverse live cash so employee holding clears.
