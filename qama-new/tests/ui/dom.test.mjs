import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../../src/frontend/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../../src/frontend/app.mjs", import.meta.url), "utf8");
const api = readFileSync(new URL("../../src/frontend/api.mjs", import.meta.url), "utf8");
const css = readFileSync(new URL("../../src/frontend/app.css", import.meta.url), "utf8");
const config = readFileSync(new URL("../../src/frontend/config.mjs", import.meta.url), "utf8");
const commands = readFileSync(new URL("../../functions/commands/index.mjs", import.meta.url), "utf8");
const finance = readFileSync(new URL("../../functions/domain/finance.mjs", import.meta.url), "utf8");
const auth = readFileSync(new URL("../../functions/auth/index.mjs", import.meta.url), "utf8");

const checks = [
  ["html rtl", () => html.includes('dir="rtl"') && html.includes('lang="ar"')],
  ["no window.confirm", () => !app.includes("window.confirm") && !app.includes("window.prompt")],
  ["no paidFils write in frontend", () => !app.includes("paidFils:") && !api.includes("paidFils:")],
  ["no status in command payloads", () => !app.includes('status: "collected"')],
  ["no hardcoded demo pins in frontend", () => !html.includes("1325") && !app.includes("1325") && !config.includes("1325")],
  ["no deviceId in login api", () => !api.includes("deviceId")],
  ["login selects user then pin", () => api.includes("listLoginUsers") && app.includes("selectedLoginUser") && api.includes("userId")],
  ["login shows arabic roles", () => app.includes("مالك / مدير") && app.includes("الموظفون")],
  ["uses server commands", () => app.includes("runCommand") && api.includes("httpsCallable")],
  ["min touch target css", () => css.includes("min-height: 44px") || css.includes("min-height: 48px")],
  ["mobile viewport", () => html.includes("viewport")],
  ["arabic title", () => html.includes("قمة الرواسي")],
  ["receive remaining button", () => app.includes("استلام المتبقي")],
  ["receipt history screen", () => app.includes("renderReceiptHistory")],
  ["bank submission", () => app.includes("submitBankReceipt")],
  ["deposit submission", () => app.includes("submitDeposit")],
  ["expense submission", () => app.includes("submitExpense")],
  ["owner approvals", () => app.includes("renderApprovals") && app.includes("approveBankReceipt")],
  ["deposit approval", () => app.includes("approveDeposit")],
  ["reversals", () => app.includes("reverseReceipt") && app.includes("reverseDeposit")],
  ["user management", () => app.includes("createUser")],
  ["property unit space rental", () => app.includes("createProperty") && app.includes("createUnit") && app.includes("createSpace") && app.includes("createRental")],
  ["obligation generation", () => app.includes("generateObligations")],
  ["close rental", () => app.includes("closeRental")],
  ["role gated owner manage", () => app.includes('role === "owner"') || app.includes("isOwner()")],
  ["no financial formulas in client", () => !app.includes("periodSummary") && !app.includes("holdingByEmployee")],
  ["functions domain self-contained", () => !commands.includes("src/domain")],
  ["operation id for idempotency", () => api.includes("newOperationId")],
  ["inline confirm not dialog", () => !app.includes("<dialog")],
  ["emulator config placeholder", () => config.includes("USE_EMULATOR")],
  ["unit hierarchy apartment cards", () => app.includes("unitListCard") && app.includes("unitTree") && app.includes("البارتشنات")],
  ["apartment drill-in", () => app.includes("unitDetail") && app.includes("spaceRowCard")],
  ["familiar tabs", () => app.includes("الوحدات") && app.includes("الرئيسية") && app.includes("الإيداعات")],
  ["backend finance untouched marker", () => finance.includes("STATUS_AR") && auth.includes("loginWithPin")],
];

for (const [name, fn] of checks) {
  test(`UI: ${name}`, () => assert.ok(fn(), name));
}
