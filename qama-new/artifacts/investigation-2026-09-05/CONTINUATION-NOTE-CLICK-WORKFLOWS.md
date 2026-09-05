# Checkpoint — UI click workflows complete

**Checkpoint:** `qama-new/artifacts/investigation-2026-09-05/CHECKPOINT-20260905T213713Z/`  
**Generated:** 2026-09-05T21:37:13Z  
**Suite:** `tests/browser/assembled_ui_click_workflows.mjs` (real clicks/selects/typing only; `__qamaTest.engineCommand` / `applyCollection` not used as user actions)  
**Result:** **6 PASS / 0 FAIL** (`browser-click-workflows-results.json`)

Production correction and deploy remain **pending — do not apply**.

---

## Do not re-run unless code changes

| Suite | Status |
|-------|--------|
| Domain/integration + prior browser matrix/workflows | Prior session PASS (bridge_mediated financials not counted as these four) |
| Residue emulator rehearsal | Prior PASS |
| **Click-only four workflows + inventory** | **This checkpoint: 6/6 PASS** |

---

## Workflow results (summary)

### 1. Partition + full-unit status (real UI)
- **Partition:** collect → late → collect → late → partial 40 cash. Holding 0→100→0→100→0→40 AED. Refresh + relogin persisted partial. **PASS**
- **Full unit 201:** same cycle + partial 75. Holding +75 AED after partial. **PASS**

### 2. Daily booking
- Form cancel before save (no card). Create 2 nights × 100 = 200. Edit → 3×150 = 450. Edit-form cancel (no leak). Delete saved → 0. Financials via `savePeriodExtras` rollup only (no receipts). **PASS**
- **Code:** owner daily **تعديل** was missing; added edit form + `data-testid`s.

### 3. Employee requests
- Employee submits expense 33 + expense 44 (triple-click → 1 pending). Manager اعتماد + رفض. Employee sees resolved. **PASS**
- **Code:** `submitRequest` now sets `S.submitting` before any `await`; expense dupe check by amount+desc.

### 4. Month lock
- Owner locks → refresh persists. Owner still edits. Employee add/edit blocked. Unlock → employee edit resumes. **PASS**
- Established rule: owner `canEdit()` always true when locked.

### Action inventory
- PRINT / EXPORT → **NOT AVAILABLE**
- Full matrix: `action-inventory-click.json` (COVERED / PRIOR / NOT TESTED / NOT AVAILABLE)

---

## Code changes this session (local only, undeployed)

| Area | Change |
|------|--------|
| Shell | `data-testid` on tabs, lock, partition/full status/method/partial/paid, daily CRUD, expense, req approve/reject |
| Shell | Daily booking **تعديل** / edit cancel; full-unit method visible when `u.partial` |
| Shell | `submitRequest` early `S.submitting` + expense dupe guard |
| Bridge | Persist/restore extras `partial` + `paid_amount`; skip partial apply without `collectionMethod` |
| Seed | Vacant partition + whole unit 201 for click fixtures |
| Tests | `assembled_ui_click_workflows.mjs` |
| Assemble | `npm run assemble:ui` → `src/frontend/index.html` |

---

## How to re-run (isolation only)

```bash
cd qama-new
npm run assemble:ui
firebase emulators:exec --project qama-new-prod-2026 \
  --only firestore,auth,functions,hosting \
  "node seed/seed_bridge_ui.mjs && node tests/browser/assembled_ui_click_workflows.mjs"
```

---

## Still deferred (authorized later)

1. `OWNER_PIN=… node scripts/prod_full_residue_correction.mjs --apply`
2. `npm run deploy:prod -- --only hosting`
3. Physical iPhone rental-save confirmation

---

## If another session resumes

1. Read this note + `CHECKPOINT-20260905T213713Z/` + `browser-click-workflows-results.json`.
2. Do **not** repeat click workflows unless shell/bridge/seed changed.
3. Next authorized work is production residue apply + hosting deploy (only when explicitly requested).
4. Branch `recovery/qama-prod-2026-08-13.6` is legacy; source of truth for UI is `qama-new/`.
