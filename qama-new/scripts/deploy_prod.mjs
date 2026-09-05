/**
 * Production deploy wrapper. Requires an explicit project flag.
 *
 * Usage:
 *   node scripts/deploy_prod.mjs --project qama-new-prod-2026 --only functions,hosting
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ALLOWED = "qama-new-prod-2026";
const args = process.argv.slice(2);

function projectFromArgs(list) {
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "--project" || list[i] === "-P") return list[i + 1] || "";
    if (list[i].startsWith("--project=")) return list[i].slice("--project=".length);
    if (list[i].startsWith("-P=")) return list[i].slice(3);
  }
  return "";
}

const project = projectFromArgs(args);
if (!project) {
  console.error("DEPLOY GUARD: --project is required. Refusing.");
  process.exit(1);
}
if (project !== ALLOWED) {
  console.error(`DEPLOY GUARD: --project ${project} is not ${ALLOWED}. Refusing.`);
  process.exit(1);
}

const root = path.dirname(fileURLToPath(new URL(".", import.meta.url)));
const child = spawn("npx", ["firebase-tools", "deploy", ...args], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 1));
