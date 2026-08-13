import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function browserHarness({ failFirstRefresh = false } = {}) {
  const html = fs.readFileSync("public/index.html", "utf8");
  let code = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
  code = code.replace(/^import\s+.*?;$/gm, "").replace(/await import\([^)]*\)/g, "({})");
  const calls = []; const economicEffects = new Set(); let readCount = 0;
  const model = {
    monthKey: "2026_08", role: "manager", balances: { company: 10000, revenue: 500000, deduction: 20000 },
    requests: [], projection: {
      cards: { targetFils: 300000, collectedFils: 100000, depositedFils: 100000, receivedNotDepositedFils: 0, arrearsFils: 200000, notYetDueFils: 0, uncollectedAtEvictionFils: 0 },
      details: { target: [{ cycleId: "c1", targetFils: 300000, remainingFils: 200000 }], collected: [{ cycleId: "c1", amountFils: 100000 }], deposited: [{ amountFils: 100000 }], receivedNotDeposited: [], arrears: [{ remainingFils: 200000 }], notYetDue: [], uncollectedAtEviction: [] },
      custodyByEmployee: {}, accounting: { externalRevenueFils: 0 },
    },
  };
  const mkEl = () => ({ style: {}, children: [], appendChild(x) { this.children.push(x); }, addEventListener() {}, setAttribute() {}, removeChild() {}, insertBefore() {}, classList: { add() {}, remove() {} }, focus() {}, value: "", textContent: "" });
  const ctx = { console, setTimeout: () => 0, clearTimeout() {}, Date, Math, JSON, Number, String, Object, Array, Boolean, isNaN, isFinite, Promise,
    crypto: { randomUUID: () => "stable-browser-operation" },
    document: { getElementById: (id) => id === "root" ? mkEl() : null, addEventListener() {}, createElement: mkEl, createTextNode: (x) => ({ textContent: x }), body: mkEl() },
    window: { addEventListener() {}, location: {}, confirm: () => true, prompt: () => null }, location:{hostname:"test.invalid",search:""}, URLSearchParams, navigator: {},
    initializeApp: () => ({}), getAuth: () => ({}), getFunctions: () => ({}), getFirestore: () => ({}),
    httpsCallable: (_functions, name) => async (payload) => {
      calls.push({ name, payload: structuredClone(payload) });
      if (name === "financialCommand") {
        economicEffects.add(payload.operationId);
        return { data: { operationId: payload.operationId, replay: calls.filter((x) => x.name === name && x.payload.operationId === payload.operationId).length > 1 } };
      }
      if (name === "operationalReadModel" || name === "canonicalReadModel") {
        readCount++;
        if (failFirstRefresh && readCount === 1) throw new Error("READ_NETWORK_FAILURE");
        return { data: structuredClone(model) };
      }
      return { data: { users: [] } };
    },
    signInWithCustomToken: async () => ({}), signOut: async () => {}, onAuthStateChanged: () => {},
    doc: () => ({}), getDoc: async () => ({ exists: () => false }), setDoc: async () => {}, serverTimestamp: () => ({}), runTransaction: async () => {}, collection: () => ({}), getDocs: async () => ({ docs: [] }), query: () => ({}), where: () => ({}),
  };
  ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(code, ctx);
  vm.runInContext("loadRequests=async()=>{}", ctx);
  vm.runInContext('S.user="manager";S.uid="uid-manager";S.userKey="manager";S.role="owner";S.screen="home";S.year=2026;S.month=7;USERS.manager={name:"Manager",role:"owner"};', ctx);
  return { ctx, calls, economicEffects, model };
}

test("operational financial value wins while month occupancy data remains readable", async () => {
  const { ctx } = browserHarness();
  await vm.runInContext("loadOperationalReadModel()", ctx);
  const result = vm.runInContext('({target:CALC.target({units:[{partitions:[{rent:9999,status:"late"}]}]}),collected:CALC.actualCollected({transactions:[{amount:7777}]}),legacyOperational:{name:"Tenant Legacy",phone:"050"}})', ctx);
  assert.equal(result.target, 3000);
  assert.equal(result.collected, 1000);
  assert.deepEqual(structuredClone(result.legacyOperational), { name: "Tenant Legacy", phone: "050" });
});

test("command success plus refresh failure never becomes a second economic effect", async () => {
  const { ctx, calls, economicEffects } = browserHarness({ failFirstRefresh: true });
  const first = await vm.runInContext('runUiFinancialCommand({command:"recordExternalRevenue",identity:"form-1",payload:{amountFils:500000,source:"other",reason:"documented"}})', ctx);
  assert.equal(first.refreshPending, true);
  assert.equal(economicEffects.size, 1);
  const firstOperationId = calls.find((x) => x.name === "financialCommand").payload.operationId;
  await vm.runInContext('runUiFinancialCommand({command:"recordExternalRevenue",identity:"form-1",payload:{amountFils:500000,source:"other",reason:"documented"}})', ctx);
  const commandCalls = calls.filter((x) => x.name === "financialCommand");
  assert.equal(commandCalls.length, 2);
  assert.equal(commandCalls[1].payload.operationId, firstOperationId);
  assert.equal(economicEffects.size, 1);
  assert.equal(vm.runInContext("S.operationalReadModel.projection.cards.collectedFils", ctx), 100000);
});

test("QAMA loads the operational read model without a Canonical control state", async () => {
  const { ctx, calls } = browserHarness();
  await vm.runInContext("loadOperationalReadModel()", ctx);
  assert.equal(vm.runInContext("window.QAMA_READY", ctx), true);
  assert.equal(vm.runInContext("S.canonicalControlState", ctx), undefined);
  assert.equal(calls.some((x) => x.name === "operationalReadModel"), true);
});
