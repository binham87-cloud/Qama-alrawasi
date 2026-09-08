# FINAL-REPAIR-REPORT

**Project:** `qama-new-prod-2026` only (`https://qama-new-prod-2026.web.app`)  
**Source:** `/workspaces/Qama-alrawasi/qama-new`  
**Completed:** 2026-09-07T19:55:00Z  
**Legacy `qama-alrawasi`:** not touched  

---

## FINAL STATUS

**READY FOR OWNER PHYSICAL IPHONE RETEST**

Not staff-ready until you personally verify on iPhone Safari.

---

## ROOT CAUSES FIXED THIS PASS

1. **Deposit request history after approval** — employee identity matching + sparse terminal cards; enriched history now keeps قيد الاعتماد → معتمد/مرفوض permanently with amount/source/dates/deposit ID.
2. **Bank detail after approval** — engine pending card correctly vanishes; permanent bank history was display-only in deposits but not surfaced as lasting history cards. Added `bankhist:*` + stronger deposit/financial row labels. **No second financial mutation.**
3. **Old test receipts clutter** — 70 proven TEST receipts archived operationally (`operationalHidden`), not deleted. 14 ambiguous left unchanged.
4. **MZ3 numbering** — not a sort bug. Clean-baseline proves 1–12 active; live had inactive 1/5/8/10 and invented 13–16. Structural flags repaired safely.

---

## FILES CHANGED

- `functions/services/readModel.mjs` — richer ui.requests fields; hide archived test receipts from spaceReceipts
- `src/frontend/old-qama-shell.html` — isMyRequest, enrichDepositRequestFields, bankhist cards, enriched myrequests/manager cards, deposit history labels
- `src/frontend/index.html` — assembled
- `scripts/prod_physical_retest_repair.mjs` — backup + classify + archive + MZ3 repair
- `scripts/prod_physical_retest_accept.mjs` — focused acceptance
- Reports: progress / results / this file / staff-readiness / PHYSICAL-RETEST-REMAINING-FIXES.md

---

## VERDICT TABLE

| Check | Result |
|-------|--------|
| DEPOSIT REQUEST BEFORE APPROVAL | **PASS** |
| AFTER APPROVAL REMAINS VISIBLE | **PASS** |
| APPROVED AFTER REFRESH/RELOGIN | **PASS** |
| REJECTED AFTER REFRESH | **PASS** |
| MANAGER SEES DEPOSIT AMOUNT | **PASS** |
| BANK COLLECTED / DEPOSITED once | **PASS** |
| BANK HOLDING | **UNCHANGED** |
| BANK HISTORY VISIBLE | **PASS** |
| BANK DOUBLE COUNT | **NO** |
| TEST RECEIPTS ARCHIVED | **70** |
| AMBIGUOUS LEFT | **14** |
| LEGITIMATE RECEIPTS DELETED | **0** |
| MZ3 CANONICAL/RENDERED | **1..12** |
| PARTITION DATA LOST | **NO** |
| TYPE 123456 / DATE / WRITES | **PASS / PASS / 0** |
| FIRST-ATTEMPT SAVE | **PASS** |
| DELEGATED YAHYA | **PASS** |
| UNRELATED DATA CHANGED | **0** (except documented TEST archive + MZ3 flags) |
| Physical suite | **33/33** |
| Focus suite | **20/20** |
| PHYSICAL IPHONE SAFARI | **NOT TESTED BY AGENT** |

## DEPLOY

- Hosting SHA-256: `fe6bca116c5fd93933684aeae04cbe8e5fa45cdd9dbd71866ca421918419a6c5`
- Live body matches workspace assembled `index.html`
- Functions updated (read model)

## BACKUP

`artifacts/release/BACKUP-pre-physical-retest-2026-09-07T19-41-15-Z/`

---

**Do not declare READY FOR STAFF USE until physical iPhone Safari retest passes.**
