# Expense 60 vs 160 — evidence (qama-new-prod-2026)

Source dump: `artifacts/investigation-2026-09-05/prod-expense-breakdown-160.json`  
Period summary `expensesFils` = **16000** (= **160 AED**). Only `state:"approved"` rows count toward the KPI.

## Approved rows that sum to 160 AED

| ID | AED | category | reason |
|----|-----|----------|--------|
| `exp:uiexp-1788645077195-1000` | **10** | عام | `1` |
| `exp:uimaint-1788645088698-2000` | **20** | صيانة | `2` |
| `exp:uimaint-1788645101150-3000` | **30** | صيانة | `3` |
| `exp:cwr-req_1788645450831-exp` | **100** | عام | `1` |

**60 = 10 + 20 + 30** (the three UI expense/maintenance lines without the 100).  
**160 = 60 + 100** (same three + the approved cash-withdrawal request expense `exp:cwr-req_1788645450831-exp`).

Many other expense docs exist in the dump but are `state:"reversed"` and are **not** in the summary (reversed sum in dump ≈ 877.50 AED bookkeeping residue; approved-only = 160).

## Verdict
The jump from a perceived **60** to dashboard **160** is exactly the additional approved **100 AED** line `exp:cwr-req_1788645450831-exp`, not double-counting of the 10/20/30 set.
