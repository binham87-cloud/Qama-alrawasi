# Employee Rental Entry — Verification

Build: `qama-phase3d-employee-rental-entry-2026-08-12.4`
Baseline: `qama-phase3c-canonical-events-2026-08-12.3-clean-august-start` (manifest 130/130 verified)

## Executed locally (Node 22) — PASSED

| Suite | Result |
|---|---|
| `npm test` (full regression) | 269 passed / 2 failed* |
| `test:phase3c-bootstrap` | 20 passed, exit 0 |
| `test:canonical-events` | 30 passed, exit 0 |
| `test:reconstruction` | 13 passed, exit 0 |
| `test:staging-lock` | 6 passed, exit 0 |
| `test:structural-preparation` | 7 passed, exit 0 |
| `test:dynamic-cycles` | 13 passed, exit 0 |
| `test:size` | exit 0 |
| **`test:rental-entry` (new)** | **12 passed, exit 0** |
| **`test:deposit-cancellation` (new)** | **13 passed, exit 0** |

\* CS10 and HX13 fail reading `/tmp/backups/phase3c-121-before-historical-exception-.../`, an absolute path from the original engineering machine. **Identical 244/246 failure occurs on the untouched baseline before any change** — verified by running the pristine extract. Not caused by this work.

## UNRUN — require Firebase Emulator (unavailable: `firebase` CLI absent, `npm install` returns E403)

- `test:rules` — UNRUN
- `test:functions-integration` — UNRUN
- `test:concurrency` — UNRUN
- `test:pin-functions` — UNRUN
- `test:browser-journeys` — UNRUN

**No claim of financial verification is made for the deposit-cancellation path.** It must not be activated in Production until these execute successfully.

## Changes

### 1. `setSpaceRental` (new command)
Employee opens an existing space and records current reality. IDs derived deterministically (`tenancy:{spaceId}`, `cycle:{spaceId}:{monthKey}`) so re-saving updates in place. Zero financial effect. Blocked once `financialVersion > 0`. Unknown names → audited `unresolved` occupant, never fabricated.

### 2. `correctCycleDueDate` (new command)
Manager-only, reason mandatory, preserves `previousDueDate` and full `dueDateHistory`, audited. Recalculates arrears/not-yet-due via existing selectors.

### 3. `cancelDeposit` (new command)
Manager-only, reason mandatory. Pending → cancelled, no reversal. Approved → exactly-once reversal of revenue balance, ledger, cash movement and allocation settlement. Original preserved as `reversed` with full audit.

### 4. Three engine corrections (required by #3)

**(a) `canonical_selectors.mjs` — Deposited KPI filtered `amountFils > 0`.** A reversal movement would have been dropped silently, leaving Deposited overstated after a cancellation. Now accepts `deposit_reversal` and negates its sign.

**(b) `financial_engine.mjs` — `cashLotAvailable` restored custody only on type `reversal`.** Cancelled deposit cash would never have returned to employee custody. Now includes `deposit_reversal`.

**(c) `command_processor.mjs` — movement amount kept positive.** `cashLotAvailable` calls `requirePositive`, which throws on negatives; the sign is applied in the KPI layer instead.

Each was found by wiring the reversal, not by test failure. Without them money is silently lost or custody left inconsistent.

### 5. Units UI
Familiar QAMA card: existing spaces visible, no structure recreation, no technical IDs exposed. Occupied unpaid → متأخر/RED. Vacant → فارغ. Full collection → محصل/GREEN. Partial → جزئي. All writes via `runUiFinancialCommand` (stable operationId, in-flight guard, replay detection). No direct Firestore writes.

### 6. Deposits UI
Manager-only `حذف الإيداع` with confirmation dialog and mandatory reason. Cancelled shows `ملغي`, struck through, excluded from active Deposited.

## Behaviour proven by tests

Target derives from valid cycles and is non-zero (SR03) · Collected and Deposited start at zero (SR02, DC01) · balances preserved (SR02) · structure never duplicated (SR01, SR05) · retry exactly-once (SR06, DC06) · double reversal impossible (DC05) · custody restored (DC04) · ledger balanced (DC11) · employee denied manager actions (SR10, DC07) · audit preserved (DC10) · replacement deposit works (DC12).

## Final build identity (delivery correction)

Runtime markers unified to `qama-phase3d-employee-rental-entry-2026-08-12.4`:

| Location | Before | After |
|---|---|---|
| `index.html` meta `qama-build-id` | `qama-phase2-local-2026-08-10.1` | final build |
| `index.html` `const BUILD_ID` | `...2026-08-11.15-canonical-active-ui-routing` | final build |
| `public/index.html` | same two markers | final build |
| `package.json` name | `qama-v11-delivery` | `qama-phase3d-employee-rental-entry` |
| `BUILD-ID.txt` | — | final build |

`tests/phase2_artifacts.test.mjs` asserted the old meta string. Its stated intent is *"build identity is explicit and both local hosting sources are identical"* — the pinned literal was incidental, so it now asserts the final identity. The invariant is unchanged and still enforced.

Historical reports that intentionally reference earlier builds were **not** rewritten.

Verified: zero stale runtime markers remain in `index.html`, `public/index.html`, `functions/`, `scripts/`, `auditor/`, `package.json`, `firebase.json`.

## Files changed
`functions/domain/command_processor.mjs` · `functions/domain/canonical_selectors.mjs` · `functions/domain/financial_engine.mjs` · `index.html` · `public/index.html` · `package.json` · `BUILD-ID.txt` · `tests/space_rental_entry.test.mjs` (new) · `tests/deposit_cancellation.test.mjs` (new)

## Production
NOT deployed. No Production access in this environment. No Production data modified. Deposit-cancellation path NOT activated.
