import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

for (const file of ["index.html", "public/index.html"]) {
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  test(`${file} routes active reconstruction dashboard and units to canonical-only renderers`, () => {
    assert.match(source, /function canonicalReconstructionWorkspaceActive\(\)/);
    assert.match(source, /canonicalControlState\|\|""\)==="RECONSTRUCTION_ALLOWED"/);
    assert.match(source, /S\.tab==="overview"\|\|S\.tab==="emphome"\)content=renderCanonicalReconstructionOverview\(\)/);
    assert.match(source, /S\.tab==="units"\)content=renderCanonicalReconstructionUnits\(\)/);
  });
  test(`${file} gives employees the canonical workspace without manager structural authority`, () => {
    assert.match(source, /const workspaceContext=authorizedReconstructionWorkspaceContext\(\)/);
    assert.match(source, /S\.reconstructionMode=workspaceContext\?\{enabled:true,\.\.\.workspaceContext\}:null/);
    const workspaceStart=source.indexOf("function authorizedReconstructionWorkspaceContext()");
    const workspaceEnd=source.indexOf("function canonicalId",workspaceStart);
    const workspaceBlock=source.slice(workspaceStart,workspaceEnd);
    assert.ok(workspaceStart>=0&&workspaceEnd>workspaceStart);
    assert.doesNotMatch(workspaceBlock,/model\.role/);
    const managerStart=source.indexOf("function authorizedReconstructionStructuralContext()");
    const managerEnd=source.indexOf("function authorizedReconstructionWorkspaceContext()",managerStart);
    const managerBlock=source.slice(managerStart,managerEnd);
    assert.match(managerBlock,/model\.role\|\|""\)!=="manager"/);
  });
  test(`${file} canonical reconstruction views source structure and KPIs only from canonical read model`, () => {
    const start = source.indexOf("function renderCanonicalReconstructionOverview()");
    const end = source.indexOf("function renderApp()", start);
    const block = source.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.match(block, /S\.canonicalReadModel/);
    assert.match(block, /model\.projection\?\.cards/);
    assert.match(block, /model\.structure/);
    assert.match(block, /model\.rentalCycles/);
    assert.doesNotMatch(block, /getCurData\(|S\.data|paid_amount|displayStatus\(|Legacy.*status/);
  });
  test(`${file} explicitly labels Legacy as historical evidence and empty canonical workspace`, () => {
    assert.match(source, /بيانات Legacy محفوظة كأدلة تاريخية ولا تظهر هنا كحقيقة تشغيلية/);
    assert.match(source, /لا تعرض هذه الصفحة مستأجري Legacy أو حالاتهم المالية/);
    assert.match(source, /لا توجد مساحات قانونية بعد/);
  });
}
