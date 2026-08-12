import fs from "node:fs";

// Deterministic synthetic fixture. It contains no Production names, IDs,
// amounts, notes, PINs or tenant/unit data. Its shape deliberately exercises
// every analyzer confidence/reason branch used by the Phase 2 exit evidence.
const documents = {};
const put = (path, data) => { documents[path] = data; };

for (let i = 1; i <= 7; i++) put(`bankPayments/safe-verified-${i}`, {
  status: "approved", amount: 100, paymentDate: "2026-01-01",
  createdBy: "synthetic-actor", unitRef: `synthetic-unit-${i}`,
});

for (let i = 1; i <= 135; i++) put(`requests/safe-partial-cash-${i}`, {
  type: "add_transaction", status: "approved", approvedAt: "2026-01-01T00:00:00Z",
  by: "synthetic-actor", payload: { amount: 100, method: "cash" },
});

for (let i = 1; i <= 3; i++) put(`requests/safe-partial-bank-${i}`, {
  type: "add_transaction", status: "approved", approvedAt: "2026-01-01T00:00:00Z",
  by: "synthetic-actor", payload: { amount: 100, method: "bank" },
});

for (let i = 1; i <= 198; i++) put(`requests/safe-missing-amount-${i}`, {
  type: "add_transaction", status: "pending", payload: {},
});

for (let i = 1; i <= 168; i++) put(`requests/safe-missing-method-${i}`, {
  type: "add_transaction", status: "pending", payload: { amount: 100 },
});

for (let i = 1; i <= 5; i++) put(`requests/safe-missing-collector-${i}`, {
  type: "add_transaction", status: "pending", payload: { amount: 100, method: "cash" },
});

// 98 non-candidate documents make the total exactly 614 and prove that the
// analyzer safely skips unrelated records. One synthetic balances document
// also exercises deterministic before/after balance preservation.
put("config/balances", { companyBalance: 1000, revenueBalance: 2000, installmentBalance: 3000 });
for (let i = 1; i <= 97; i++) put(`operationalFixtures/safe-${i}`, {
  kind: "synthetic-non-financial", ordinal: i,
});

if (Object.keys(documents).length !== 614) throw new Error("FIXTURE_COUNT_MISMATCH");
const output = new URL("../tests/fixtures/migration-sanitized-614.json", import.meta.url);
fs.mkdirSync(new URL("../tests/fixtures/", import.meta.url), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify({ fixture: "SANITIZED_DETERMINISTIC", documents }, null, 2)}\n`);
console.log(output.pathname);
