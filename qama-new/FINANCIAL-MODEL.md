# Financial model

All money is an integer number of fils. 1 AED = 100 fils. No float touches a money value at
any layer, including JSON transport. A float amount is rejected by the command schema.

## Events, not totals

There is no `paidFils` field on an obligation. Each tenant payment is its own **receipt**:

```
Receipt A  5,000  cash  collector: yahia
Receipt B  4,000  cash  collector: nader
                        ─────────────────
Paid = 9,000, and each collector's custody is attributed separately.
```

Reversal is a state change plus a linked `reversals` record. Nothing is edited or deleted, so
a reversed receipt still appears in history, marked.

## Definitions

Let `R(o)` be receipts on obligation `o` with `state = recognized`.

| Figure | Definition |
|---|---|
| Due | `obligation.amountFils` while `state = active` |
| Paid | `Σ R(o).amountFils` |
| Remaining | `Due − Paid` |
| Status | `Paid ≥ Due` → collected · `Paid > 0` → partial · past due → late · else not_due |
| Target | `Σ` Due over active obligations in the period |
| Actual Collected | `Σ` recognized receipts in the period |
| Remaining (period) | `Target − Actual Collected` |
| Arrears | `Σ Remaining` over obligations whose due date has passed |
| Deposited | approved deposits **+** recognized bank receipts (decision D1) |
| Holding (employee) | recognized **cash** receipts collected by them − their approved deposits |
| Total Holding | `Σ` per-employee Holding |
| Approved Expenses | `Σ` approved expenses in the period |

## Decisions in force

- **D1** An approved bank receipt increases Collected *and* Deposited, and creates no custody.
  That money never entered a pocket.
- **D2** Overpayment is refused. `AMOUNT_EXCEEDS_REMAINING` reports due, paid, remaining and
  the attempted amount. Nothing is clamped; nothing is discarded.
- **D6** Employee cash is recognized immediately. Deposits still require owner approval.

## Historical stability

An obligation snapshots the rent at generation time and is never edited. Raising the rent in
November does not change the August report. Closing a rental or vacating a space changes no
past period: neither is an input to a period report.

## No clamping

`Math.max(0, …)` appears nowhere on a balance, custody or reversal path. Negative custody is
a real reconciliation fault: it is surfaced as `NEGATIVE_HOLDING`, shown to the owner, and it
blocks further deposits by that employee until it is resolved deliberately.
