import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

for(const file of ["index.html","public/index.html"]){
  const source=fs.readFileSync(new URL(`../${file}`,import.meta.url),"utf8");
  test(`${file} routes RECONSTRUCTION_ALLOWED before any Legacy month read`,()=>{
    const app=source.slice(source.indexOf("function renderApp()"),source.indexOf("// Build global alert bar"));
    const boundary=app.indexOf("if(canonicalReconstructionWorkspaceActive())return renderCanonicalReconstructionShell()");
    const legacyRead=app.indexOf("const data=getCurData()");
    assert.ok(boundary>=0&&legacyRead>boundary,"canonical routing boundary must precede getCurData");
    assert.match(source,/function canonicalReconstructionWorkspaceActive\(\)\{\s*return String\(S\.canonicalControlState\|\|""\)==="RECONSTRUCTION_ALLOWED"/);
  });
  test(`${file} resolves the authoritative staged reconstruction month dynamically`,()=>{
    assert.match(source,/const reconstructionMonthKey=getMonthKey\(S\.year,S\.month\)/);
    assert.match(source,/RECONSTRUCTION_ALLOWED.*!model\.monthAuthority/);
    assert.match(source,/alternateModel\.monthAuthority\?\.monthKey===reconstructionMonthKey/);
    assert.match(source,/function canonicalReadModelMatchesSelectedMonth\(\)/);
  });
  test(`${file} renders collection only from an explicit canonical cycle`,()=>{
    const start=source.indexOf("function renderCanonicalReconstructionUnits(");
    const end=source.indexOf("function renderCanonicalAdminControls()",start);
    const block=source.slice(start,end);
    assert.match(block,/related\.map\(cycle/);
    assert.match(block,/canonicalCashCollectionControl\(\{cycleId:cycle\.id/);
    assert.doesNotMatch(block,/getCurData\(|displayStatus\(|paid_amount|S\.data/);
  });
}
