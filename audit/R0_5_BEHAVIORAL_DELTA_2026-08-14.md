# R0.5 Behavioral Delta — Familiar workflow vs Production `.6`

**References (not replacements):**  
- Familiar operational reference: approved index `335e418` + unified `.2` `3bb9d97`  
- Current Production: Hosting `.6` + `operationalCommand` `.6` package  
- Financial protections introduced later: `dd02975` onward + `.6` HAT repairs  

**Product principle:** Harden finance *under* the familiar workflow. Status alone must never mint money. Do not implement restores in this document.

---

## محصّل — reconstructed original satisfactory workflow (evidence)

From `335e418` `public/index.html` (approved production index):

1. **User action:** Open unit/partition edit → change الحالة select to **محصّل** (`collected`).  
2. **Fields changed:** `status="collected"`; `partial=false`; `collectedBy=<user>`; `collectedAt=ISO`. **Does not auto-write `paid_amount=rent` in the status handler.**  
3. **Financial numbers:** Legacy KPI/`displayStatus` treated `status===collected` as fully collected (rent counts as received). No `cashLots` / `createCashReceipt` in that build.  
4. **Payment amount:** Separate **المدفوع** (`paid_amount`) input existed; partial path used `partial` + amount.  
5. **Cash/bank:** Not selected on this status control in the approved index (no `createCashReceipt` there).  
6. **Did محصّل merely reflect payment?** Operationally it *meant* “paid/collected” to staff; accounting-wise it **was the collection signal** for KPIs.  
7. **Did selecting محصّل create financial effects?** **Yes for KPI/projection** (status-as-collected). **No** modern custody ledger events.  
8. **Employee:** Local edit, then **إرسال للاعتماد**; fields including status shipped in request payload.  
9. **Owner:** Direct month write via save path / approval.  
10. **After reload:** Persisted `status` (and related tags) on month document drove UI again.

**`.2` (`3bb9d97`):** Same familiar select **including محصّل**, plus parallel `createCashReceipt` financial path already present — status path still not blocked server-side (`COLLECTION_REQUIRES` absent until `dd02975`).

**`.6`:** Select options **`late|vacant|staff` only**; client `sanitizeBusinessRequestPayload` rejects/strips collected/partial; server `validateRentalPatch` throws `COLLECTION_REQUIRES_FINANCIAL_COMMAND`; transfer normalizes collected→`late` and clears residue on vacate/staff.

### Smallest future solution direction (NOT implemented)

Restore **محصّل in the familiar control**, but:

- Selecting it must **not** increase Actual Collected / create payments / cashLots by itself.  
- Actual Collected rises only from cash/bank financial commands (existing controls).  
- After a successful financial collect that covers the cycle, UI may show محصّل (derived from ledger **or** an occupancy label kept in sync without KPI minting).  

Exact A vs B wiring deferred until R1 authorization; evidence shows the owner’s familiar action was “set الحالة → محصّل”, while money truth must move under financial evidence.

---

## Behavioral delta matrix (user actions)

| # | Screen | Control | Role | Old (familiar / `.2`) | `.6` behavior | Why changed | Intentional financial protection? | Accidental operational regression? | Code path | Evidence | Proposed minimal restoration (later) | Invariant to protect |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Units edit | الحالة select | Owner/Emp | Options: محصّل/متأخر/فارغ/موظفين | Options: متأخر/فارغ/موظفين only; collected shown as متأخر | HAT: stop status inventing collection | Partial (goal valid) | **Yes** — deleted familiar control | Prod HTML `occ=["late","vacant","staff"]` | Hosting SHA `6711b9a7…` | Restore محصّل option; no money mint | Actual Collected event-backed only |
| 2 | Units edit | Select محصّل | Owner | Writes status+collectedBy/At; KPI counts rent collected | Cannot select; if forced, sanitize/server reject | `dd02975`+`.6` sanitize | **Yes** (ban mint) | **Yes** (workflow unusable) | `updateP`/`sanitizeBusinessRequestPayload` → `operationalCommand` → `validateRentalPatch` | `335e418` updateP; `.6` sanitize; domain opCmd | Keep reject of money fields; allow label/UX under evidence | No status-minted fils |
| 3 | Units edit | Select متأخر/فارغ/موظفين | Both | Works | Works; vacate/staff clears paid residue server-side | Residue KPI skew | **Yes** clear residue | No | `clearCollectionResidue` / `applyVacateResidueIfNeeded` | `.6` `domain/operational_commands.mjs` | Keep clear-on-vacate | Vacant ≠ collected KPI |
| 4 | Units edit | المدفوع / جزئي | Emp/Owner | Editable; drove partial/collected displays | Financial fields stripped on submit; partial gated | Stop operational path writing money fields | **Yes** | Partial UX friction | sanitize deny set; FORBIDDEN_FINANCIAL | `.6` HTML + domain | Keep strip; use cash/bank UI for money | No paid_amount via occupancy request |
| 5 | Units | Cash collect control | Emp/Owner | `.2+` `createCashReceipt` | Present; custody lots | Hardening | **Yes** | No | `financialCommand` / cashLots | `.5`/`.6` packages | Keep | Cash → Collected↑ Holding↑ |
| 6 | Units | Bank collect | Emp/Owner | Financial command path | Present | Hardening | **Yes** | No | `financialCommand` | packages | Keep | Bank → Collected↑ Deposited↑ |
| 7 | Income | «+ إيداع» / «+ إيراد آخر» | Owner | Label confusion (deposit vs external) | «+ إيراد آخر» | HAT P1 mislabel | **Yes** | No | HTML CTA | `.6` vs `.3` HTML | Keep `.6` label | Deposit ≠ external revenue |
| 8 | Custody | Handover/deposit approve | Owner | Holding→Deposited | Same intent; clearer INSUFFICIENT_CUSTODY copy in `.6` HTML msgs | HAT | **Yes** | No | deposit approve path | `.6` HTML messages | Keep | Deposit not new collection |
| 9 | Transfer | تحويل مستأجر | Emp→Owner | Could copy `status:collected` | Client remaps collected→late; strips paid; server `normalizeTransferOccupancyStatus` | P0 invent-collected | **Yes** | Minor UX (dest not “محصّل”) | sanitize + transfer branch | `.6` HTML + domain | Keep no-invent; allow late/tenant move | Transfer ≠ collection event |
| 10 | Units | تسجيل مغادرة / vacate | Both | Could leave paid_amount | Clears residue when status vacant/staff | KPI integrity | **Yes** | No if UX still vacates | `clearCollectionResidue` | domain `.6` | Keep | No vacant+paid KPI lie |
| 11 | Units | New tenant / dates / rent | Both | Familiar fields | Still editable occupancy fields; dates DD-MM-YYYY inputs | Date HAT | Date keep | Date change intentional | `qamaDateInput` / `formatQamaDate` | `.6` HTML | Keep DD-MM-YYYY; ISO storage | Semantic dates |
| 12 | Units | Renewal / cycle dates | Both | `type=date` ISO chrome | DD-MM-YYYY text | Owner date req | N/A | No (desired) | date helpers | `.6` | Keep | — |
| 13 | Dashboard | Target | Owner | Sum rents excluding vacant/staff | Same exclusion; roof vacant HAT dropped −2250 | Data state + projection | Projection rules | Data not code | legacy projection / month | Aug audit | No auto data fix | Target from occupancy contracts |
| 14 | Dashboard | Actual Collected | Owner | Often status/`paid_amount` legacy | Mix: cards may use operational fils when present; legacy tags still risk | Hardening incomplete | Keep event path | Status path removed without full UX replace | selectors / HTML CALC | audits | KPI from events; UX محصّل derived | Collected ≠ status |
| 15 | Dashboard | Deposited / Holding / Arrears | Owner | Distinct in engine | Distinct; orphan 900 breaks holding trail | Data orphan | Keep engine | Data track separate | cashLots/payments | Aug audit | No reconcile in R0 | Holding from lots |
| 16 | Requests | Owner approve update_partition | Owner | Could approve collected status | Approve hits COLLECTION_REQUIRES if collected/partial present | Gate | **Yes** | Dead-end if UI offered محصّل (`.5`) | `applyApprovedBusinessRequest` → validateRentalPatch | domain | Don’t offer unpaid محصّل writes | Gate remains |
| 17 | PIN login / roles | — | All | PIN chooser | Unchanged in `.6` scope | — | — | No | pinLogin/listPinUsers | `.5` package still live | Keep | Auth intact |

---

## Root causes of operational regressions (summary)

1. **`dd02975`:** Server occupancy patch bans `collected`/`partial` → familiar محصّل write path dies.  
2. **`.6` HAT HTML:** Removed محصّل from select instead of keeping control while blocking money mint → **workflow regression**.  
3. **Uncommitted `.4–.6` + V2 cleanup:** `main` left on `.3` while Prod on `.6` → change-control failure (fixed in R0 recovery branch for UI+opCmd package).  
4. **Legacy KPI still status-sensitive** under compatibility → engineers deleted UX rather than separating projection (wrong layer).

---

## Financial protections that must remain untouched

- Idempotent financial commands; no duplicate money on retry/refresh/double-click  
- Cash vs bank vs deposit/handover semantics  
- `FORBIDDEN_FINANCIAL` / no `paid_amount` via occupancy-only requests  
- `COLLECTION_REQUIRES_FINANCIAL_COMMAND` for **money-implying** writes without financial command  
- Transfer cannot persist invented collected money  
- Vacate/staff clears display paid residue  
- Deposit/external revenue not conflated  
- Unauthorized financial writes blocked  

---

## Minimal proposed code changes (DO NOT APPLY — R1 later)

| File | Function / locus | Intent |
|---|---|---|
| `index.html` / `public/index.html` | Status `<select>` `occ=[...]` | Restore محصّل to options |
| same | `sanitizeBusinessRequestPayload` / status change handler | Allow familiar selection without shipping money fields; guide/derive collected display from financial evidence |
| `functions/domain/operational_commands.mjs` | `validateRentalPatch` / transfer helpers | Keep money ban; possibly allow non-minting occupancy label policy once defined — **no change until authorized** |
| projection/selectors (if needed) | collected KPI | Count events not status-only tags |

---

## Exact test plan (later; classify before edits)

1. Inventory current tests touching `COLLECTION_REQUIRES`, status select, transfer, vacate, dates.  
2. Classify each: **INVARIANT** vs **REGRESSION-ENCODED**.  
3. Keep all genuine financial invariant tests.  
4. Add new regression tests for restored familiar UX (محصّل visible; status alone doesn’t create cashLots/payments; cash/bank still do).  
5. Do not weaken invariant tests to greenwash.

---

## August data (untouched)

- Roof 2250 HAT mutation — separate  
- Orphan 900 — separate  
No reads required for R0; no writes allowed.
