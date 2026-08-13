import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const FILES = ["index.html", "public/index.html"];

test("index.html and public/index.html are identical", () => {
  assert.equal(fs.readFileSync("index.html", "utf8"), fs.readFileSync("public/index.html", "utf8"));
});

for (const file of FILES) {
  const html = fs.readFileSync(file, "utf8");
  const render = html.slice(html.indexOf("function renderApp()"));

  test(`${file} boots QAMA without CANONICAL_ACTIVE or reconstruction mode`, () => {
    assert.doesNotMatch(html, /CANONICAL_BACKEND_REQUIRED/);
    assert.doesNotMatch(html, /CANONICAL_ACTIVE/);
    assert.doesNotMatch(html, /adminReconstructionMode/);
    assert.doesNotMatch(html, /canonicalReconstructionWorkspaceActive/);
    assert.doesNotMatch(html, /canonicalOperationalWorkspaceActive/);
    assert.doesNotMatch(html, /renderCanonicalOperationalShell/);
    assert.doesNotMatch(html, /renderCanonicalReconstructionShell/);
    assert.doesNotMatch(html, /MIGRATION_REQUIRED/);
    assert.doesNotMatch(render, /إعادة البناء/);
    assert.match(html, /function renderApp\(\)/);
    assert.ok(render.indexOf("const data=getCurData()") >= 0);
    assert.ok(render.indexOf("function renderApp()") < render.indexOf("const data=getCurData()"));
  });

  test(`${file} owner and employee use familiar QAMA screens`, () => {
    assert.match(html, /const tabs=isOwner\?\["overview","financial","transactions","requests","units","daily","occupancy","maintenance","expenses","audit","permissions"\]/);
    assert.match(html, /\["emphome","units","daily","maintenance","expenses"\]/);
    assert.match(html, /قمة الرواسي/);
    assert.match(html, /\["لوحة "\+nm\]/);
    assert.match(html, /🏠 الرئيسية/);
    assert.match(html, /units:"الوحدات"/);
    assert.match(html, /\["\+ شقة بارتشنات"\]/);
    assert.match(html, /\["\+ شقة كاملة"\]/);
  });

  test(`${file} has no financial UI path that calls commitMoneyOp`, () => {
    assert.match(html, /async function commitMoneyOp\(opts\)\{\s*return blockLegacyFinancialWrite\("commitMoneyOp"\);/);
    const afterDef = html.slice(html.indexOf("async function commitMoneyOp"));
    const callSites = [...afterDef.matchAll(/commitMoneyOp\(/g)];
    assert.equal(callSites.length, 1, "commitMoneyOp must remain defined but unreachable from UI");
  });

  test(`${file} keeps financial writes on the server-side command path`, () => {
    assert.match(html, /httpsCallable\(functions,"financialCommand"\)/);
    assert.match(html, /httpsCallable\(functions,"operationalReadModel"\)/);
    assert.match(html, /function dispatchLegacyFinancialRequest/);
    assert.match(html, /return dispatchLegacyFinancialRequest\(type, desc, payload\)/);
    assert.match(html, /command:"confirmCustodyTransfer"/);
    assert.match(html, /command:"rejectCustodyTransfer"/);
    assert.match(html, /command:"createDailyBooking"/);
    assert.match(html, /command:"requestExpense"/);
    assert.match(html, /command:"approveExpense"/);
    assert.match(html, /command:"reverseExpense"/);
    assert.match(html, /command:"cancelDeposit"/);
    assert.match(html, /command:"createCashReceipt"/);
    assert.match(html, /command:"setSpaceRental"/);
    assert.match(html, /command:"createBankPayment"/);
    assert.doesNotMatch(html, /reconstructionPayloadForUi/);
    assert.doesNotMatch(html, /CANONICAL_WRITES_DENIED/);
    assert.doesNotMatch(html, /structuralCommandCall|sendStructuralCommand|httpsCallable\(functions,"structuralCommand"\)/);
  });

  test(`${file} rejects pending requests through the operational server path`, () => {
    assert.match(html, /async function rejectRequest\(req\)\{/);
    assert.doesNotMatch(html, /blockLegacyFinancialWrite\("rejectRequest"\)/);
    assert.match(html, /payload:\{command:"rejectRequest",requestId\}/);
    assert.match(html, /operationalCommandCall\(\{operationId,payload:\{command:"rejectRequest",requestId\}\}\)/);
    assert.match(html, /onClick:\(\)=>rejectRequest\(req\)\},\["✗ رفض"\]/);
  });

  test(`${file} loads pending handovers from custodyTransfers`, () => {
    assert.match(html, /function loadOperationalHandovers/);
    assert.match(html, /getDocs\(collection\(db,"custodyTransfers"\)\)/);
    assert.match(html, /S\.operationalHandovers/);
    const pending = html.slice(html.indexOf("const _hvSrc="), html.indexOf("const _hvSrc=") + 400);
    assert.match(pending, /S\.operationalHandovers/);
    assert.doesNotMatch(pending, /canonicalReadModel/);
  });
}
