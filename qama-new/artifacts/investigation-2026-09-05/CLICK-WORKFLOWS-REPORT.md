# UI click workflows — verification report

**Date:** 2026-09-05T21:37Z  
**Mode:** Emulator isolation only (`qama-new-prod-2026`). No production writes. No deploy.

**Evidence:** `artifacts/investigation-2026-09-05/browser-click-workflows-results.json`  
**Checkpoint:** `CHECKPOINT-20260905T213713Z/`  
**Continuation:** `CONTINUATION-NOTE-CLICK-WORKFLOWS.md`

## Verdict

All four remaining authorized workflows completed with **real browser UI actions** (clicks / select / typing). Internal reads only for assertions. **6/6 PASS.**

## Cases

| Case | Actions | Expected | Actual | Result |
|------|---------|----------|--------|--------|
| Partition collect↔uncollect + partial | Units → expand part 1 → status/method cycles → partial 40 cash → refresh/relogin | Holding 0↔100↔0↔100↔0↔40; UI persists | holdingFils=4000, paid=40, partial=true, liveReceipts=1, reversed=2 | **PASS** |
| Full-unit collect↔uncollect + partial | Expand 201 → same cycle → partial 75 | Holding +7500 on partial | paid=75, holding matched | **PASS** |
| Daily create→edit→cancel | Form cancel; create 200; edit 450; edit cancel; delete | Extras rollup; no receipts from daily | month total 0 after delete; holding unchanged by daily | **PASS** |
| Employee approve+reject | Emp submit 33 & 44 (dup-click); mgr اعتماد+رفض | 1 approved expense + 1 rejected; emp visibility | approved/rejected uiRequests + expense effect | **PASS** |
| Month lock/unlock | Lock → refresh → owner ok / emp blocked → unlock | Role restrictions as designed | Observed | **PASS** |
| Action inventory | Classify remaining controls | PRINT/EXPORT N/A | See JSON | **PASS** |

## Fixes applied while running (app, not test substitutes)

1. Draft `partial`/`paid_amount` survive hydrate via extras (partition partial race).
2. Full-unit collection method shown when `u.partial`.
3. `submitRequest` duplicate-click flag before awaits; expense content dupe check.
4. Daily owner **تعديل** control (workflow required edit of saved booking).
5. Stable `data-testid` hooks for click suite.

## Not done

- Production residue correction `--apply`
- Hosting deploy
- Building print/export (marked NOT AVAILABLE)
