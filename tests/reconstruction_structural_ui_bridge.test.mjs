import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read=(path)=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");

for(const path of ["index.html","public/index.html"]){
  test(`${path} bridges structural administration through authoritative reconstruction context`,()=>{
    const html=read(path);
    assert.match(html,/gate==="RECONSTRUCTION_ALLOWED"/);
    assert.match(html,/authorizedReconstructionStructuralContext\(\)/);
    assert.match(html,/origin:"reconstruction",reconstructionPlanId:context\.planId/);
    assert.match(html,/const authority=model\.monthAuthority\|\|\{\},planId=String\(authority\.reconstructionPlanId\|\|""\)/);
    assert.match(html,/authority\.status!=="STAGED"\|\|authority\.activated===true/);
    assert.match(html,/plan\.id===planId&&plan\.monthKey===monthKey&&plan\.status==="DRAFT"/);
    assert.match(html,/String\(model\.role\|\|""\)!=="manager"/);
    assert.match(html,/matches\.length===1\?\{planId,monthKey\}:null/);
    assert.match(html,/else if\(gate!=="CANONICAL_ACTIVE"\)throw new Error\("STRUCTURAL_ADMIN_GATE_CLOSED"\)/);
    assert.match(html,/function saveCurData\(\)\{return Promise\.reject\(new Error\("LEGACY_STRUCTURAL_WRITE_DISABLED"\)\)/);
  });
}
