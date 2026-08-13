import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

for (const file of ["index.html", "public/index.html"]) {
  const html = fs.readFileSync(file, "utf8");
  const render = html.slice(html.indexOf("function renderApp()"));

  test(`${file} uses familiar QAMA screens as the only workspace`, () => {
    assert.doesNotMatch(html, /renderCanonicalOperationalShell|renderCanonicalReconstructionShell/);
    assert.ok(render.indexOf("const data=getCurData()") >= 0);
    assert.doesNotMatch(render, /adminReconstructionMode/);
  });

  test(`${file} still guards commitMoneyOp and never calls it from UI`, () => {
    assert.match(html, /return blockLegacyFinancialWrite\("commitMoneyOp"\)/);
    const afterDef = html.slice(html.indexOf("async function commitMoneyOp"));
    const callSites = [...afterDef.matchAll(/commitMoneyOp\(/g)];
    assert.equal(callSites.length, 1, "commitMoneyOp must remain defined but unreachable from UI");
  });

  test(`${file} routes money actions through the secure dispatcher`, () => {
    assert.match(html, /function dispatchLegacyFinancialRequest/);
    assert.match(html, /command:"confirmCustodyTransfer"/);
    assert.match(html, /command:"rejectCustodyTransfer"/);
    assert.match(html, /command:"createDailyBooking"/);
    assert.match(html, /command:"requestExpense"/);
    assert.match(html, /command:"approveExpense"/);
    assert.match(html, /command:"reverseExpense"/);
    assert.match(html, /command:"cancelDeposit"/);
  });

  test(`${file} loads pending handovers from custodyTransfers, not a product-mode read model`, () => {
    assert.match(html, /function loadOperationalHandovers/);
    assert.match(html, /getDocs\(collection\(db,"custodyTransfers"\)\)/);
    assert.match(html, /S\.operationalHandovers/);
    const pending = html.slice(html.indexOf("const _hvSrc="), html.indexOf("const _hvSrc=") + 400);
    assert.match(pending, /S\.operationalHandovers/);
    assert.doesNotMatch(pending, /canonicalReadModel|operationalReadModel/);
  });
}
