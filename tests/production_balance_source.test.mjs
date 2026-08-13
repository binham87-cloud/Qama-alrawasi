import test from "node:test";
import assert from "node:assert/strict";

/**
 * Pure unit coverage for the Production balance compatibility rule used by
 * operationalReadModel: empty accountBalances must not invent zeros when
 * config/balances holds the authoritative AED balances.
 */
function resolveDisplayedBalances({ accountBalanceDocs, configBalances }) {
  const fromAccounts = { company: null, revenue: null, deduction: null };
  let accountDocs = 0;
  for (const doc of accountBalanceDocs || []) {
    accountDocs += 1;
    fromAccounts[doc.id] = Number(doc.amountFils || 0);
  }
  const fromConfig = {
    company: Math.round(Number(configBalances?.companyBalance ?? 0) * 100),
    revenue: Math.round(Number(configBalances?.revenueBalance ?? 0) * 100),
    deduction: Math.round(Number(configBalances?.installmentBalance ?? 0) * 100),
  };
  if (accountDocs === 0) {
    return { balances: fromConfig, balancesSource: configBalances ? "config/balances" : "empty" };
  }
  return {
    balances: {
      company: fromAccounts.company ?? 0,
      revenue: fromAccounts.revenue ?? 0,
      deduction: fromAccounts.deduction ?? 0,
    },
    balancesSource: "accountBalances",
  };
}

test("Production shape: config/balances populated + accountBalances empty → real balances", () => {
  const out = resolveDisplayedBalances({
    accountBalanceDocs: [],
    configBalances: { companyBalance: 491754, revenueBalance: 70863.95, installmentBalance: 91172.48 },
  });
  assert.equal(out.balancesSource, "config/balances");
  assert.equal(out.balances.company, 49175400);
  assert.equal(out.balances.revenue, 7086395);
  assert.equal(out.balances.deduction, 9117248);
});

test("accountBalances present wins over config/balances", () => {
  const out = resolveDisplayedBalances({
    accountBalanceDocs: [
      { id: "company", amountFils: 100 },
      { id: "revenue", amountFils: 200 },
      { id: "deduction", amountFils: 300 },
    ],
    configBalances: { companyBalance: 491754, revenueBalance: 70863.95, installmentBalance: 91172.48 },
  });
  assert.equal(out.balancesSource, "accountBalances");
  assert.equal(out.balances.company, 100);
});

test("UI must not apply empty balancesSource over previously loaded values", () => {
  const model = { role: "manager", balances: { company: 0, revenue: 0, deduction: 0 }, balancesSource: "empty" };
  const S = { companyBalance: 491754, revenueBalance: 70863.95, installmentBalance: 91172.48, balancesLoaded: true };
  if (model.role === "manager" && model.balances && model.balancesSource && model.balancesSource !== "empty") {
    S.companyBalance = Number(model.balances.company || 0) / 100;
  }
  assert.equal(S.companyBalance, 491754);
});
