import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

for(const file of ["index.html","public/index.html"]){
  const html=fs.readFileSync(file,"utf8");
  test(`${file} routes CANONICAL_ACTIVE before every Legacy operational read`,()=>{
    const render=html.slice(html.indexOf("function renderApp()"));
    assert.ok(render.indexOf("if(canonicalOperationalWorkspaceActive())return renderCanonicalOperationalShell()")>=0);
    assert.ok(render.indexOf("if(canonicalOperationalWorkspaceActive())return renderCanonicalOperationalShell()")<render.indexOf("const data=getCurData()"));
  });
  test(`${file} permanent canonical shell is plan-independent and Legacy-free`,()=>{
    const start=html.indexOf("function renderCanonicalOperationalShell()");
    const end=html.indexOf("function renderApp()",start);
    const shell=html.slice(start,end);
    assert.match(shell,/canonicalReadModelMatchesSelectedMonth/);
    assert.match(shell,/renderCanonicalOperationalOverview/);
    assert.match(shell,/renderCanonicalReconstructionUnits\("active"\)/);
    assert.doesNotMatch(shell,/reconstructionPlanId|getCurData\(|displayStatus\(|paid_amount|data\.units|data\.full/);
  });
  test(`${file} collections are rendered only from explicit canonical cycles`,()=>{
    assert.match(html,/if\(!cycleId\)throw new Error\("CANONICAL_CYCLE_REQUIRED"\)/);
    assert.match(html,/canonicalCashCollectionControl\(\{cycleId:cycle\.id/);
    assert.doesNotMatch(html,/canonicalCashCollectionControl\(\{unitId:/);
  });
  test(`${file} Legacy evidence is isolated and read-only`,()=>{
    const start=html.indexOf("function renderLegacyEvidenceView()");
    const end=html.indexOf("function renderCanonicalOperationalShell()",start);
    const evidence=html.slice(start,end);
    assert.match(evidence,/أدلة Legacy التاريخية — قراءة فقط/);
    assert.match(evidence,/getMonthData/);
    assert.doesNotMatch(evidence,/onClick|setDoc|sendFinancialCommand|sendStructuralCommand|canonicalCashCollectionControl/);
  });
  test(`${file} permanent canonical operation controls remain present`,()=>{
    for(const marker of ["إيداع نقدي","تحصيل بنكي","مصروف تشغيلي","نقل عهدة","تحويل لاحتياطي الأقساط","دفع قسط بنكي","استرداد","تصحيح/عكس دفعة","الإدارة القانونية","الإيداعات","الطلبات"]){
      assert.ok(html.includes(marker),marker);
    }
  });
}
