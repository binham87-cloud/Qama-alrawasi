# Release report — qama-new-prod-2026 clean + deploy

**When:** 2026-09-05T21:45Z–21:48Z UTC  
**Target:** https://qama-new-prod-2026.web.app  
**Legacy `qama-alrawasi`:** untouched

## What was fixed
- Draft `partial`/`paid_amount` hydrate: mid-edit only; **discarded after reverse/uncollect**; **blocked across rental cycles** (`draftForRentalId` + `mergeDraftPartial`)
- Partial apply still requires explicit `collectionMethod` (no auto-receipt on refresh)
- Daily booking owner **تعديل**; UI `data-testid`s; `submitRequest` dup-click guard
- September clean reset: reverse **deposits before receipts** (fixes `RECEIPT_ALREADY_DEPOSITED`)

## What test data was cleaned
- All live Sep receipts/deposits/expenses reversed or already historical
- Active rentals closed; spaces vacant (structure preserved)
- Period extras wiped (daily/maintenance/drafts/logs reset note kept)
- UI balances zeroed
- Orphan TEMP obligation cancelled after deposit→receipt order fix
- History retained as reversed/closed (not deleted)

**Pre-clean backup:** `artifacts/release/BACKUP-pre-clean-deploy-20260905T214326Z/`

## Deployed
- **Scope:** hosting only (frontend bridge/shell; no Cloud Functions source change required)
- **URL:** https://qama-new-prod-2026.web.app
- **index.html SHA-256:** `6ab28a3747cb9c562ea6d6659e843c69136924f4e314df741436fdf9921cb1ab` (live matches local)
- **Git HEAD at deploy:** `33b30f230543e64ebddfd76c22771674340e0ad9` (workspace; release commit follows)

## Live verification
- API + UI login: owner, يحيى, نادر — **PASS**
- Tabs: الوحدات، المالية، المصاريف، الطلبات — **PASS**
- Financial zero state — **PASS**
- Smoke: submitExpense 1 AED → reverseExpense → KPIs remain 0 — **PASS**

## Final balances (2026-09)
| Metric | Fils |
|--------|------|
| target | 0 |
| collected | 0 |
| remaining | 0 |
| holding | 0 |
| deposited | 0 |
| expenses | 0 |
| rented spaces | 0 |

## Remaining limitation
- Prior test docs remain in Firestore as **reversed/closed** history (intentional; not wiped).
- Employee PINs are operational secrets (not stored in repo artifacts).
- Workspace git branch still carries large unrelated legacy dirty tree; release commit scopes **qama-new paths only**.
