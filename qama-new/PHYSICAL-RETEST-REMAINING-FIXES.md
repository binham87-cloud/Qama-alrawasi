# PHYSICAL-RETEST-REMAINING-FIXES

**Project:** qama-new-prod-2026  
**Live:** https://qama-new-prod-2026.web.app  
**Source:** `/workspaces/Qama-alrawasi/qama-new`  
**When:** 2026-09-07T19:55:00Z  

---

## What was still broken on physical iPhone (owner report)

1. Employee deposit request vanished after Manager approval  
2. Approved bank/deposit detail disappeared from lasting history  
3. Old reversed TEST receipts (200 / 9,000 / 100 / 1,000 … ملغي/معكوس) still cluttered UI  
4. MZ3 partition sequence still wrong (gaps + invented highs) — not merely sort  

Prior session claimed bank/manager-amount PASS but did **not** prove employee approved-history permanence in DOM after refresh/relogin.

---

## Fixes applied (no full reset)

### Deposit request history
- Hardened `isMyRequest` identity matching  
- Read-model request fields: `byKey`, `byUid`, `resolvedAt`, `depositId`  
- Enrich terminal deposit requests from deposits collection  
- `طلباتي` cards show employee/amount/source/dates/status/deposit ID permanently  

### Bank permanence
- Ledger already correct (Collected+Deposited via bank recognition)  
- Added display-only `bankhist:*` history cards after approval  
- Financial/transactions rows keep معتمد + receipt ID  
- **No second deposit document / no double count**  

### Test receipt archive
- Backup then classify every receipt  
- **70 proven TEST** → `operationalHidden=true` (audit retained, hidden from operational space receipt panels)  
- **14 AMBIGUOUS** left unchanged  
- **0 legitimate deleted**  

### MZ3 structure
- Authoritative: clean-baseline 2026-09-04 → active **1–12**, no 13–16  
- Reactivated 1,5,8,10  
- Deactivated invented 13–16 (only BOT closed rental on 16)  
- All other units audited: no further discrepancies  

---

## Safety proof

| Guard | Result |
|-------|--------|
| qama-alrawasi touched | **NO** |
| Full reset / purge | **NO** |
| Unrelated rentals/obligations/receipts/deposits/expenses/requests changed | **0** (except documented TEST archive flags + MZ3 active flags) |
| Partition business data remapped/deleted | **NO** |

Backup:  
`/workspaces/Qama-alrawasi/qama-new/artifacts/release/BACKUP-pre-physical-retest-2026-09-07T19-41-15-Z`

---

## Acceptance

- Physical remaining suite: **33/33 PASS** (`artifacts/PHYSICAL-RETEST-LATEST.json`)  
- Focus/date/save suite: **20/20 PASS**  
- Hosting SHA: `fe6bca116c5fd93933684aeae04cbe8e5fa45cdd9dbd71866ca421918419a6c5`  

**PHYSICAL IPHONE SAFARI: NOT TESTED BY AGENT**

---

## Owner retest checklist (real iPhone)

1. Employee deposit → قيد الاعتماد → Manager approve → employee still sees **معتمد** after refresh + relogin  
2. Another request → Manager reject → employee sees **مرفوض** after refresh  
3. Bank approve → Collected/Deposited +X once, Holding same, history row stays  
4. Receipt panel no longer shows old CERT/BOT ملغي rows  
5. MZ3 shows **1…12** ascending, opens on 1  
6. Type `123456` one tap; date select once; one حفظ  

Do **not** declare staff-ready until those pass on device.
