# FINAL-REPAIR-PROGRESS

**Project:** qama-new → production `qama-new-prod-2026` only  
**Live site:** https://qama-new-prod-2026.web.app  
**Authoritative source:** `/workspaces/Qama-alrawasi/qama-new`  
**Updated:** 2026-09-07T19:55:00Z  
**Session outcome:** COMPLETE — READY FOR OWNER PHYSICAL IPHONE RETEST (not staff-ready)

---

## Current phase

**DONE — Physical-retest remaining fixes (deposit request history, bank history permanence, test receipt archive, MZ3 structure repair) + focused acceptance + focus regression**

Owner physical iPhone Safari retest is still required. Do **not** declare READY FOR STAFF USE until that check.

Production business data preserved (except proven TEST receipt archive flags + proven MZ3 structural correction). No reset/purge. `qama-alrawasi` not touched.

---

## 2026-09-07 — Physical remaining defects

### ISSUE 1 — DEPOSIT REQUEST DISAPPEARS AFTER APPROVAL
**Root cause (UI):** Employee `طلباتي` identity filter was brittle (`by`/`byKey` only) and deposit history cards were too sparse after terminal status; approved bank/deposit detail was not re-enriched after hydrate.

**Fix:**
- `isMyRequest()` matches `by` / `byKey` / `byUid` / `NEW_UID` / `UID_TO_KEY`
- Read model exposes `byKey`, `byUid`, `resolvedAt`, `depositId`
- `enrichDepositRequestFields()` keeps terminal deposit detail from deposits collection
- Enriched `my-request-card` with amount/source/dates/status/deposit ID (pending+approved+rejected)

### ISSUE 2 — BANK DETAIL VANISHES AFTER APPROVAL
Financial effect was already correct. Engine pending cards disappear after approve (expected).  
**Fix:** permanent display-only `bankhist:*` request cards + bank rows remain in deposits/transactions with معتمد + receipt ID. No second deposit mutation.

### ISSUE 3 — OLD TEST RECEIPTS
Inventoried 111 receipts. Classified **70 TEST**, **27 REAL**, **14 AMBIGUOUS**.  
Archived 70 proven TEST-only via `operationalHidden=true` (not deleted). Ambiguous left unchanged. Real recognized left unchanged.

### ISSUE 4 — MZ3 PARTITION STRUCTURE
Authoritative evidence: `artifacts/clean-baseline-backup-2026-09-04T21-34-33-785Z/spaces.json` → MZ3 **1–12 all active**, no 13–16.  
Live had 1/5/8/10 inactive + invented 13–16.  
**Repair applied:** reactivate 1,5,8,10; deactivate invented 13–16 (BOT-only closed rental on 16). No financial/rental remapping. All other units matched baseline.

### ISSUES 5–7
Focus/date/first-save/Yahya permissions regression **PASS** (focus suite 20/20).

---

## Deployments (this session)

| What | Project | Notes |
|------|---------|-------|
| functions + hosting | qama-new-prod-2026 | request history + receipt filter + structure already in DB |
| Firestore data | qama-new-prod-2026 | TEST receipt archive flags; MZ3 space active flags |

Backup: `artifacts/release/BACKUP-pre-physical-retest-2026-09-07T19-41-15-Z/`  
Hosting SHA-256: `fe6bca116c5fd93933684aeae04cbe8e5fa45cdd9dbd71866ca421918419a6c5`

---

## Acceptance pointers

- Physical remaining: `scripts/prod_physical_retest_accept.mjs` → **33/33**
- Focus: `scripts/prod_iphone_typing_focus_accept.mjs` → **20/20**
- Reports: `PHYSICAL-RETEST-REMAINING-FIXES.md`, this file, `FINAL-REPAIR-REPORT.md`, `STAFF-READINESS-REPORT.md`
