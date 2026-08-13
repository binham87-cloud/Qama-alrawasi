# QAMA Operational Restoration Plan — 2026-08-14

**Status:** PLAN ONLY — awaiting explicit owner authorization before any implementation.  
**Priority order:** (1) preserve data (2) familiar workflows (3) restore accidental UX regressions (4) keep proven financial protections (5) minimize diffs (6) no architecture redesign (7) avoid migrations (8) keep rollback ability.

---

## 0. Preconditions (must complete before coding)

1. **Re-sync git to Production reality** without deploying:
   - Import Hosting `.6` HTML already captured as `audit/EVIDENCE_prod_index_2026-08-13.6.html` into working `index.html` / `public/index.html` **only after owner approves implementation**.
   - Recover deployed `operationalCommand` source (Prod was updated for `.6`; local git still has pre-`.6` transfer gap). Prefer Firebase/download of the exact deployed artifact or reconstruct from `.6` intent + tests — **do not invent**.
2. Commit that recovered baseline as a freeze tag (e.g. `freeze/prod-2026-08-13.6`) when authorized — so restore work has a rollback point.
3. Do **not** touch Firestore data, Auth, rules, indexes, or live Hosting until separately authorized.

---

## 1. What stays (KEEP) — proven financial protections

Do not undo these invariants (smallest surface that enforces them):

| Protection | Primary files (current tree) | Notes |
|---|---|---|
| No duplicate financial events / idempotent commands | `functions/domain/command_processor.mjs`, `functions/domain/financial_engine.mjs`, `functions/financial_commands.mjs` | Keep |
| Cash ≠ bank; custody lots; deposit ≠ new collection | same + cashLots allocation | Keep `.6` deposit labeling («إيراد آخر» ≠ deposit) |
| Status alone must not mint money | `functions/domain/operational_commands.mjs` `validateRentalPatch` | Keep **financial** effect ban; rework UX (below) |
| Transfer must not persist invented `collected` | Prod `.6` `operationalCommand` + client sanitize | Keep; restore source into repo |
| Vacate must not leave paid residue that skews KPI | Prod `.6` operational path (claimed) | Keep once source recovered |
| Unauthorized / ambiguous financial writes blocked | rules + command auth | Keep |
| Traceability of financial mutations | command/event docs | Keep |

---

## 2. What to restore (RESTORE) — familiar operational UX

| Item | Restore toward | Exact touch points (proposed) |
|---|---|---|
| محصّل visible in unit status control | Familiar select including محصّل (as in `3bb9d97` / local `.3` select map) | `index.html` / `public/index.html` unit editor status `<select>` (Prod `.6` `occ=["late","vacant","staff"]`) |
| Ability to operate vacant/late/staff/tenant flows without dead-ends | Pre-gate request UX | Client submit helpers; avoid throwing raw `COLLECTION_REQUIRES` without a guided cash/bank path |
| Repo = Prod parity | Working tree matches what users see | Replace missing `.6` sources into git first |
| Income card wording | Keep `.6` «+ إيراد آخر» (this is restore-from-mistake of «+ إيداع») | Already correct on Prod; bring into git |

**Not restoring:** ability for status click alone to create cashLots/payments/KPI money.

---

## 3. What to rework (REWORK) — same UX, safe accounting

**Occupancy status vs collection (core):**

1. **UI:** Restore محصّل / متأخر / فارغ / موظفين as familiar controls.  
2. **Client:** Choosing محصّل must **not** write `paid_amount` or invent collection. Options (owner picks one in decision gate):
   - **A (preferred minimal):** Selecting محصّل opens/requires existing cash or bank collection control; on success, display shows محصّل from ledger/`displayStatus`.
   - **B:** Allow storing a non-financial occupancy tag (e.g. display-only) while KPIs read only financial events.
3. **Server:** Keep rejecting financial fields on operational patches; allow occupancy statuses that do not imply fils. If محصّل remains a stored label, KPI projection must ignore it unless backed by events (**projection change**, not schema migration).
4. **Transfer:** Preserve strip of paid fields; never copy collected-as-money; may copy tenant/dates/late.
5. **Dates:** Keep `.6` DD-MM-YYYY display/input (`formatQamaDate`, `parseQamaDateInput`, `qamaDateInput`); storage stays ISO `YYYY-MM-DD`.

**Proposed file list (implementation later):**

- `index.html`, `public/index.html` (status select, sanitizeBusinessRequestPayload behavior, date helpers — already on Prod `.6`)
- `functions/domain/operational_commands.mjs` (transfer validation alignment; vacate residue clear; occupancy vs collection)
- `functions/operational_commands.mjs` (callable wiring only as needed)
- Possibly `functions/domain/legacy_month_projection.mjs` / selectors if present for KPI separation (minimal)
- Tests: **document conflicts first**; update only after owner accepts behavior (do not bend product to old tests)

---

## 4. Explicit non-goals

- No QAMA V2 / Canonical product rebuild  
- No new “Canonical model” rollout  
- No schema migration unless unavoidable (none identified as required for UX restore)  
- No automatic reconciliation of roof 2250 or orphan 900  
- No deploy/push until owner authorizes a named candidate build  

---

## 5. Phased implementation sequence (after approval)

| Phase | Action | Rollback |
|---|---|---|
| R0 | Import Prod `.6` HTML + recover `operationalCommand` into git; tag freeze | Revert commit |
| R1 | Restore محصّل to status UI; wire to non-minting behavior (decision A/B) | Revert HTML/function commit |
| R2 | Align server transfer/vacate with client; KPI ignore status-only collected | Revert |
| R3 | Emulator + human journeys (owner/yahia/nader) on familiar unit flows | No Prod write |
| R4 | Owner HAT on preview channel only | Hosting preview discard |
| R5 | Prod deploy only if authorized (Hosting + named functions only) | Hosting rollback to `.6` SHA `6711b9a7…` |

---

## 6. Data items (separate owner tracks — not part of code restore)

1. **Roof room 2250** — HAT mutation; restore occupancy later with known prior state; no invented payment.  
2. **Orphan 900** — investigate/repair plan only when authorized; no silent balance edits.

---

## 7. Success criteria

- Users again operate units with familiar statuses including محصّل without dead-end errors.  
- Actual Collected / Deposited / Holding / Arrears remain distinct and event-backed.  
- Dates show DD-MM-YYYY on mobile.  
- No Production data migration.  
- Local git matches what Production runs before further edits.
