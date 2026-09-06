# Rental Cycle Renewal / Eviction — Design & Emulator Results

**Date:** 2026-09-06  
**Scope:** `qama-new` only · Emulator / in-memory tests · **NOT deployed to Production**  
**Prerequisite gate:** `GATE-100-CLOSED-BEFORE-RENEWAL.md` (vacate/holding-100 closed independently)

## Final design

Anniversary cycles keyed by tenant entry date (`rental.startDate` / `dueDayOfMonth`):

| Cycle | Example entry 15 Sep |
|-------|----------------------|
| Bounds | 15 Sep → 14 Oct inclusive end |
| Due | cycleStart (15th each month; 29–31 clamped then restored) |
| Identity | `rentalCycleId = {rentalId}_{cycleStart}` |

Three **server-atomic** commands (idempotent `operationId`):

1. **`renewRentalCycle`** — تجديد شهر  
   - Creates next cycle for same tenant/rent/space; paid=0; no auto receipt.  
   - Deterministic id → double-press / dual-device → one cycle.  
   - Early UI window (7 days) may show button; creation only on press.

2. **`endTenancy`** — إخلاء وتحويل لفارغ  
   - Closes rental, sets vacant, **keeps** recognized receipts & holding.  
   - Arrears require `arrearsDecision: "retain"` (warns with amount).  
   - Does **not** reverse money.

3. **`uncollectObligation` / `reverseReceipt`** — إلغاء تحصيل  
   - Only path that reverses receipt and decreases employee holding.

`generateObligations` seeds **only** the first cycle (`periodOf(startDate)`). Later months never auto-create cycles on open/refresh.

## Why «فارغ» used to mix with uncollect

UI `maybeUncollect` treated `status === vacant|staff` like unpaid and called `uncollectObligation` before close. Interim server `closeRental` also reversed live cash (incident fix). Together, choosing فارغ looked like إخلاء but behaved like إلغاء تحصيل. Fixed: vacate → `endTenancy` only; uncollect only on late/pending / explicit button.

## Emulator tests (all pass)

Cases 1–14 covered in `tests/domain/rental_cycle.test.mjs` + `tests/integration/rental_cycle_commands.test.mjs` (+ system/vacancy/UI bridge regressions). Suite: **73 pass**.

## Production

**Not deployed.** After Preview/Safari UI verify + backup + owner summary, deploy Hosting+Functions only.

## Limits not exercised here

- Live Preview / Safari iPhone UI click-through  
- True multi-device Firestore race (in-memory concurrent renew covered)  
- Production deploy / post-deploy cleanup by test IDs
