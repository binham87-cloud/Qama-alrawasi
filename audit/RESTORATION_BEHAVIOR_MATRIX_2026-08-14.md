# QAMA Restoration Behavior Matrix — 2026-08-14

**Mode:** Forensic only (no implementation in this pass).  
**Local HEAD:** `b6e27a2853c72db37b8bd70fe424fd15a3267d15` (`main`) — Build ID in tree: `qama-unified-final-2026-08-13.3`  
**Production Hosting (read-only fetch 2026-08-13 UTC):** Build `qama-unified-final-2026-08-13.6`, SHA-256 `6711b9a7b26b9ec8db5b81c2ce0146be5e3209babebd377585a76ecbeccaa238`  
**Evidence HTML saved:** `audit/EVIDENCE_prod_index_2026-08-13.6.html`  
**Archive branch:** `archive/qama-v1-work-2026-08-14` = `fbf9f6d` (archive commit on top of same `b6e27a2`)  
**Critical repo gap:** Builds `.4` / `.5` / `.6` were **never committed** to git; after the abandoned V2 attempt, local tree reverted to `.3` while Production Hosting still serves `.6`.

---

## Candidate baselines (proved, not guessed)

| Candidate | Commit / Build | Date | Why considered | Verdict |
|---|---|---|---|---|
| Pure approved production index | `335e418` | 2026-08-12 | Familiar UI; `displayStatus` status-native; **no** `financialCommand`; محصّل in workflow | Strong **operational UX** fossil; weak financial integrity |
| Familiar UI + early financial wiring | `626e5a0` / `88da355` | 2026-08-12 | `financialCommand` present; **no** `COLLECTION_REQUIRES` | Hybrid; still status-as-collection |
| Unified freeze RC | `029986a` → ZIP `.1` | 2026-08-13 | Familiar runtime freeze; removes Canonical UI shells | Intermediate |
| Last git commit **before** status collection ban | `3bb9d97` / `qama-unified-final-2026-08-13.2` | 2026-08-13 | Status select still `collected/late/vacant/staff`; server **no** `COLLECTION_REQUIRES` | **Best git operational UX baseline with financial callables present** |
| Inflection (status gated) | `dd02975` | 2026-08-13 | Introduces `COLLECTION_REQUIRES_FINANCIAL_COMMAND` for `collected`/`partial` in `validateRentalPatch` | Start of status UX break |
| Local main / first failed HAT deploy lineage | `b6e27a2` / `.3` | 2026-08-13 | In git; HAT failed | Not owner UX truth |
| Prod HAT candidate that failed humans | `.5` (uncommitted; SHA `6bc98347…`) | 2026-08-13 | Deployed; 24 human findings | Not owner UX truth |
| Current Production | `.6` (uncommitted; SHA `6711b9a7…`) | 2026-08-13 | Hosting + `operationalCommand` only | Current implementation evidence only |

**Chosen last proven-good operational baseline for restoration diffs:** `3bb9d97` / `qama-unified-final-2026-08-13.2`  
**Rationale:** Last commit where familiar unit statuses (including محصّل) remained operable on the server path **and** financialCommand wiring already existed — immediately before `dd02975` changed occupancy status into a financial gate.

---

## Matrix

| AREA | OLD BEHAVIOR (`3bb9d97` / `.2`, and earlier familiar UI) | CURRENT BEHAVIOR (Prod `.6`; local git = `.3`) | WHY IT CHANGED | FINANCIAL RISK | OPERATIONAL IMPACT | CLASSIFICATION | EVIDENCE | PROPOSED ACTION |
|---|---|---|---|---|---|---|---|---|
| Unit status control options | Select includes `collected` (محصّل), `late`, `vacant`, `staff` | Prod `.6`: select is **only** `late/vacant/staff`; historical `collected/partial` forced to show as `late` in the control | `.6` HAT repair removed محصّل to stop status inventing collection | Low if cash path exists | **High** — familiar “محصّل” control gone | **RESTORE** (UX) + **REWORK** (accounting under it) | Prod HTML `occ=["late","vacant","staff"]`; local `.3` still has full select | Restore محصّل in UI as **occupancy/display label**; do not let it mint money |
| Meaning of محصّل | Operational “paid/collected” tag; also fed legacy KPI `collected` via status/`paid_amount` | Server rejects `status:collected` via `COLLECTION_REQUIRES_FINANCIAL_COMMAND`; display may still show collected from ledger/`operationalTenantFinancial` | `dd02975` + `.6` sanitize | Status-as-money was real risk | Owner cannot mark/restore محصّل naturally | **REWORK** | `functions/domain/operational_commands.mjs` `validateRentalPatch`; Prod `sanitizeBusinessRequestPayload` | Keep ban on money invention; allow occupancy label synced from real receipts or explicit non-ledger flag only after owner choice |
| متأخر / فارغ / موظفين | Direct status transitions in unit editor | Still present in `.6` select | Preserved | Low | Familiar | **KEEP** | Prod/local status maps `SC` | Preserve |
| Employee submit `update_partition` with محصّل | Could submit; approval wrote status | Submit/approve blocked or stripped; dead-end requests on `.5` | Financial gate without UX redesign | Gate reduces false collected | Broken familiar flow | **REWORK** | HAT matrix HF-COLLECT-REQ-01; `.6` sanitize | Client should guide to cash/bank collect; status محصّل derived after success |
| `transfer_tenant` | Copies `status` including `collected` without rental validation | `.6` client remaps collected→`late` and strips paid fields; **local git server still copies status** (Prod `operationalCommand` was patched; source not in git) | P0 invent-collected on transfer | **High** if revert carelessly | Transfer must stay usable | **KEEP** protection / **REWORK** UX | Local `applyBusinessPayloadToMonth` transfer branch; Prod sanitize transfer | Keep no-invent rule; recover Prod `.6` function source into repo before editing |
| Vacate / leave | Left `paid_amount` residue possible | `.6` intended server clear of paid/collected residue on vacate | HAT: vacant + paid residue skews KPI | Residue skews KPI | Roof HAT case | **KEEP** clear-on-vacate for integrity; **UNKNOWN** exact Prod function body | Transcript roof `vacant`+`paid_amount:2250` | Confirm deployed function; preserve clear; restore occupancy separately |
| Cash collection | `createCashReceipt` → holding | Same intent | Hardening | Core invariant | Must stay | **KEEP** | financialCommand / cashLots paths | Preserve |
| Bank collection | Direct company path | Same intent | Hardening | Core invariant | Must stay | **KEEP** | prior audits | Preserve |
| Deposit / handover | Holding→deposited; not new collection | `.5` mislabeled «+ إيداع» as external revenue; `.6` relabel «+ إيراد آخر» | HAT P1 | High if wrong command | Labeling confusion | **KEEP** `.6` label fix | Prod has «+ إيراد آخر»; local `.3` still «+ إيداع» | Bring `.6` labeling into repo; never map deposit→external revenue |
| Date display | ISO `YYYY-MM-DD` strings; `type=date` (iOS “Aug 2026 1”) | `.6` `formatQamaDate` / `qamaDateInput` → **DD-MM-YYYY** text; store ISO | Owner date requirement + HAT dates | None (display) | Desired | **KEEP** | Prod `formatQamaDate`, zero `type:"date"` | Keep DD-MM-YYYY UI; keep ISO storage |
| KPI Target/Collected | Legacy status/`paid_amount` projection | Still partly legacy under clean-start; vacant excludes rent | Compatibility layers | Status tags still pollute if allowed | Dashboard trust | **REWORK** | August Target 173800 vs 176050 (−2250 vacant roof) | Project money from events; occupancy status separate |
| PIN / roles / permissions | PIN login, owner/employee | Preserved across unified builds | — | — | Must not regress | **KEEP** | browser journeys / deploy notes | No redesign |
| Dual device / idempotency | Financial commands idempotent | Keep | Hardening | High if removed | — | **KEEP** | financial engine tests history | Preserve |
| Canonical / Reconstruction UI | Temporarily forced; later frozen off | Removed from product mode in `029986a` | Scope expansion mistake | Confusion | High if revived | **KEEP removed** | freeze commit | Do not revive Canonical product UI / V2 |
| Local vs Prod parity | N/A | **Broken:** git=` .3`, Prod=` .6`; `.6` source missing from git | Uncommitted releases + V2 archive cleanup | Change control risk | Cannot safely patch from git alone | **RESTORE** repo↔Prod | Hosting SHA vs `git show HEAD:index.html` | Import Prod `.6` HTML (+ deployed `operationalCommand`) into git as baseline before any restore edits |
| Tests vs owner workflow | Tests green on `.3`–`.6` | Tests validated gates that removed محصّل UX | Tests elevated above owner workflow | False confidence | High | **UNKNOWN** / process | Owner instruction: tests not above business | Do not change product to satisfy conflicting tests; document first |

---

## Status / unit workflow end-to-end (current Prod `.6`)

1. **UI control** — occupancy select `late|vacant|staff` only (محصّل removed). Display map `SC` still knows محصّل for badges.  
2. **Client handler** — `sanitizeBusinessRequestPayload` strips `paid_amount/partial/collectedBy/...`; throws if fields.status is collected/partial; transfer remaps to `late`.  
3. **Callable** — `operationalCommand` (Prod updated 2026-08-13 ~20:35Z for `.6` only).  
4. **Server validation** — `validateRentalPatch` rejects collected/partial (`COLLECTION_REQUIRES`). Transfer path historically skipped this (P0); `.6` function claimed to close it — **function source not in git**.  
5. **Persistence** — month docs `months/{YYYY_M}` partition/full fields.  
6. **Read model / KPI** — legacy projection still treats status/paid tags as collected under compatibility modes.  
7. **UI render** — `displayStatus` prefers operational ledger remaining; else status tags; vacant/staff absolute.

**Payment paths (must remain):** cash → collected↑ holding↑; bank → collected↑ deposited↑; deposit/handover → holding↓ deposited↑ (not new collection).

---

## August 2026 read-only findings (no new live Firestore query this pass — ADC unavailable)

From prior Production human audit (session evidence; not re-mutated here):

| Item | Classification | Evidence |
|---|---|---|
| Roof «غرفة السطح الخارجي» `u_1779391565240` / part 1, rent 2250, set vacant during HAT; KPI Target/Collected −2250; `paid_amount:2250` residue observed | **Human acceptance-test mutation** (owner confirmed). Not corruption. Do not auto-repair. | Owner Arabic confirmation + audit notes |
| Orphan **900 AED** payment with **0** cashLots / collectionEvents | **Accounting inconsistency / orphan financial record** — separate from roof. Do not auto-reconcile. | Prior read-only Prod audit |
| Balances snapshot at that audit | Company 491754 / Revenue 70863.95 / Installment 91172.48 | Prior audit |
| Live Hosting now | `.6` confirmed by HTTP fetch SHA match | This pass curl |

**This pass Firestore writes: 0. Re-query not completed (no ADC).** Treat August numbers as last-audit evidence pending a future authorized read-only refresh.
