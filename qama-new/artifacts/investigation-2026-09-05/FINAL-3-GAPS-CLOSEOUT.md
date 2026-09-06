# FINAL REPORT — close 3 gaps (2026-09-06)

## Verdict
All three assigned gaps are **closed**, verified, and cleaned. Hosting with draft-gen fix is live on `qama-new-prod-2026`.

## 1. Stale vs fresh collect drafts
| Check | Result |
|-------|--------|
| Unit `draft_stale_vs_fresh` + updated `draft_partial_merge` | PASS |
| Emulator `draft_cycle_no_double` (seeded) | **5/5 PASS** |
| Live hosting contains `isStaleCollectDraft` / `draftReverseGen` | yes |
| Hosting SHA256 | `c2ba3c157b3c760c39c8afc1e162037d4a00af96b84f31bd84225bd0fb7060b1` |

Semantics: after any reverse, extras without `draftReverseGen` or with gen &lt; reverseCount are discarded (no method/paid/_collectDraft resurrection). New drafts stamp `draftReverseGen = reverseCount` and survive hydrate; recollect mints exactly one live receipt.

## 2. Expenses 60 → 160
See `EXPENSE-60-VS-160.md`. Approved-only sum in dump = 160 AED:
- 10 + 20 + 30 = **60**
- +100 `exp:cwr-req_1788645450831-exp` = **160**

## 3. Employee deposit UI flow (published site)
Artifact: `prod-employee-deposit-flow.json` stamp `mtp6fb5t` — **13 PASS / 0 FAIL**

Trial IDs (cleaned):
- rental `rental:empflow-rent-mtp6fb5t`
- receipt `rcpt:empflow-cash-mtp6fb5t`
- deposit approved then reversed `dep:reqdep-req_1788660764724`
- requests `req_1788660764724` (approved deposit), `req_1788660769786` (rejected expense)

Post-cleanup KPI: holding 0, live receipts 0, approved deps 0, pending 0.

## Code touched
- `src/frontend/draft_partial_merge.mjs`, `old-qama-shell.html`, `qama-engine-bridge.js`
- `scripts/assemble_old_ui.mjs`, assembled `index.html`
- tests: `draft_partial_merge.test.mjs`, `draft_stale_vs_fresh.test.mjs`, `draft_cycle_no_double.mjs`
- `scripts/prod_employee_deposit_flow.mjs`

## Stop
No further changes planned for this assignment.
