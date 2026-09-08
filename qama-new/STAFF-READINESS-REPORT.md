# STAFF-READINESS-REPORT

**Project:** `qama-new-prod-2026` only  
**Live:** https://qama-new-prod-2026.web.app  
**Source:** `/workspaces/Qama-alrawasi/qama-new`  
**Completed:** 2026-09-07T19:55:00Z  
**Legacy `qama-alrawasi`:** not touched  

---

## FINAL STATUS

**READY FOR OWNER PHYSICAL IPHONE RETEST**

Do **not** declare READY FOR STAFF USE until the owner completes the physical iPhone Safari check.

---

## THIS PASS — PHYSICAL REMAINING FIXES

| Issue | Status |
|-------|--------|
| Employee deposit request remains after approval (معتمد) | **FIXED + PASS** |
| Rejected deposit request remains (مرفوض) | **FIXED + PASS** |
| Manager sees deposit amount before approval | **PASS** |
| Bank approved history remains visible | **FIXED + PASS** |
| Bank Collected/Deposited once, Holding unchanged | **PASS** |
| Old TEST receipts archived from operational UI | **70 archived** |
| Ambiguous receipts left unchanged | **14** |
| MZ3 structure restored to 1..12 | **FIXED + PASS** |
| Typing / date / first-save / Yahya permissions | **PASS** |

---

## MZ3 STRUCTURE (REPAIRED)

| Field | Value |
|-------|--------|
| Authoritative source | clean-baseline-backup-2026-09-04 spaces.json |
| Canonical active IDs | 1,2,3,4,5,6,7,8,9,10,11,12 |
| Rendered IDs | 1,2,3,4,5,6,7,8,9,10,11,12 |
| Fix | reactivate 1,5,8,10; deactivate invented 13–16 |
| Partition data lost | **NO** |
| Other units | audited; matched baseline |

---

## BACKUP

`qama-new/artifacts/release/BACKUP-pre-physical-retest-2026-09-07T19-41-15-Z/`  
Includes Firestore business collections + receipt classification + repair plan.

---

## ACCEPTANCE

| Suite | Result |
|-------|--------|
| `prod_physical_retest_accept.mjs` | **33/33 PASS** |
| `prod_iphone_typing_focus_accept.mjs` | **20/20 PASS** |
| Physical iPhone Safari | **NOT TESTED BY AGENT** |

Artifacts:
- `artifacts/PHYSICAL-RETEST-LATEST.json`
- `artifacts/physical-retest-2026-09-07T19-52-17/`
- `artifacts/IPHONE-TYPING-FOCUS-LATEST.json`

---

## DEPLOY

- functions + hosting → `qama-new-prod-2026`
- Live hosting SHA-256: `fe6bca116c5fd93933684aeae04cbe8e5fa45cdd9dbd71866ca421918419a6c5`

---

**Owner must retest on real iPhone Safari before approving staff use.**
