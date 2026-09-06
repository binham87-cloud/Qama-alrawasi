# Hotfix release report — 2026-09-05 (post TENANT_REQUIRED / deposit / installment)

**Project:** `qama-new-prod-2026`  
**URL:** https://qama-new-prod-2026.web.app  
**Scope:** Hosting only (assembled Old UI + engine bridge). Functions unchanged.  
**Backup:** `artifacts/release/BACKUP-pre-hotfix-20260905T220627Z/`

## Root causes (with evidence)

### 1) TENANT_REQUIRED / green card then refresh wipe
- Selecting **محصّل** without a tenant still attempted engine `createRental` → `TENANT_REQUIRED`.
- Optimistic UI showed collected/cash while save failed; rent draft survived in extras, occupancy did not.
- Full collect also applied cash **before** an explicit method was chosen, and hydrate could wipe the method picker mid-edit because draft `status` in extras was not restored.
- After `createRental`, `applyCollection` often had **no obligationId** (stale dash space) → UI محصّل with **holding 0**.

### 2) Deposit rejected (100 from 0)
- Correct holding gate. Holding was 0 because collect never persisted. Not disabled.

### 3) Installment “paid” logs / UI 0 of 0 / balance 20706
- `installmentSchedule: []` from uiConfig wiped defaults; pay mutated an ephemeral fallback object; balance deducted once (200000−179294=20706) but schedule never persisted → “0 من 0” and repeated success logs on re-click.
- Prod schedule synced: 3 paid through 2026-06-30, next 2026-09-30, balance kept **20706**.

### 4) Expenses / maintenance
- Left unchanged. Prod still shows expensesFils **16000**, revenueBalance **−160**.

## Fixes shipped

| Area | Change |
|------|--------|
| Tenant gate | `requireTenantBeforeRent` / `tenantNameOk`; block collected/late/pending & method without tenant; keep rent draft; clear tenant resets rented statuses |
| Collect | Require `collectionMethod` for full collect; refresh obligations after createRental; `mergeDraftStatus` preserves method-picker draft |
| Deposit copy | «إيداع من العهدة» + helper (not new rental income); async save + holding hint |
| Installment | `ensureInstallmentSchedule`; async pay with guard + persist schedule; `btn-pay-installment` |
| Tests | `tests/browser/tenant_installment_regressions.mjs` + `mergeDraftStatus` unit cases |

## Files changed (qama-new)

- `src/frontend/old-qama-shell.html`
- `src/frontend/qama-engine-bridge.js`
- `src/frontend/draft_partial_merge.mjs`
- `src/frontend/index.html` (assembled)
- `scripts/assemble_old_ui.mjs` (prior keepDraft / loadBalances)
- `tests/browser/tenant_installment_regressions.mjs`
- `tests/ui/draft_partial_merge.test.mjs`
- `scripts/prod_sync_installment_schedule.mjs`
- `scripts/prod_hotfix_live_verify.mjs`

## Verification

### Emulator (390×844 Chromium)
`tenant_installment_regressions.mjs` → **7/7 PASS** (block without tenant; collect+holding; deposit 100→900; over-deposit rejected; installment restore+pay once+relogin).

### Live site (Chromium mobile viewport 390×844)
`prod_hotfix_live_verify.mjs` after deploy:
- Markers present (tenant gate, إيداع من العهدة, mergeDraftStatus)
- Installment **مدفوع: 3 من 6 أقساط**
- Collect without tenant → status vacant, rent 1000 kept, holding 0
- Tenant + cash collect → holding 1000; persists refresh + relogin
- Deposit 100 → holding 900
- Cleanup: holding **0**, no BOT-HOTFIX tenants, no recognized receipts

### Final prod KPIs (2026-09)
- holding **0**, deposited **0**, recognized receipts **0**
- expensesFils **16000**, revenueBalance **−160** (user’s prior expense/maintenance)
- installmentBalance **20706**, schedule **6** with **3** paid

## Intentionally correct behavior
- Deposit over holding still rejected (server authoritative).
- No fake tenants; server `TENANT_REQUIRED` retained.
- Negative revenue from expenses not “fixed” by wiping.

## Not fully re-verified on live in this pass
- Employee PIN deposit→manager approve path (owner deposit path verified).
- Physical iPhone Safari (Chromium mobile emulation only).
- Full month lock / daily booking matrix (covered earlier in assembled click suite; not re-run end-to-end here).
