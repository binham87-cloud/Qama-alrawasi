/**
 * Fail-closed production deploy guard for qama-new.
 *
 * Refuses Firebase deploy unless the explicit target is qama-new-prod-2026.
 * Never allow qama-alrawasi (legacy rollback/archive) from this tree.
 */
import fs from "node:fs";

const ALLOWED = "qama-new-prod-2026";
const FORBIDDEN = "qama-alrawasi";

function fail(msg) {
  console.error(`DEPLOY GUARD: ${msg}`);
  console.error(`DEPLOY GUARD: refusing. Required: --project ${ALLOWED}`);
  process.exit(1);
}

function procTokens(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
  return raw.toString().split("\0").filter(Boolean);
}

function ppidOf(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.indexOf(")") + 1).trim().split(/\s+/)[1]);
}

function isFirebaseCliToken(tok) {
  const base = tok.split("/").pop();
  return base === "firebase" || base === "firebase-tools";
}

function projectFromTokens(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--project" || tokens[i] === "-P") return tokens[i + 1] || "";
    if (tokens[i].startsWith("--project=")) return tokens[i].slice("--project=".length);
    if (tokens[i].startsWith("-P=")) return tokens[i].slice(3);
  }
  return "";
}

function findFirebaseDeployTokens() {
  let pid = process.pid;
  for (let i = 0; i < 12; i++) {
    try {
      const tokens = procTokens(pid);
      const idx = tokens.findIndex(isFirebaseCliToken);
      if (idx >= 0 && tokens[idx + 1] === "deploy") return tokens.slice(idx);
      pid = ppidOf(pid);
      if (!pid || pid === 1) break;
    } catch {
      break;
    }
  }
  return null;
}

const envProject = String(
  process.env.GCLOUD_PROJECT || process.env.PROJECT_ID || process.env.FIREBASE_PROJECT || "",
).trim();

if (!envProject) fail("no Firebase project id in environment (GCLOUD_PROJECT/PROJECT_ID)");
if (envProject === FORBIDDEN) fail(`active project is ${FORBIDDEN} (legacy). Do not deploy from qama-new.`);
if (envProject !== ALLOWED) fail(`active project is '${envProject}', not ${ALLOWED}`);

const fbTokens = findFirebaseDeployTokens();
if (fbTokens) {
  const flagged = projectFromTokens(fbTokens);
  if (!flagged) {
    fail("--project was omitted on firebase deploy. Explicit --project qama-new-prod-2026 is required.");
  }
  if (flagged === FORBIDDEN) fail(`--project ${FORBIDDEN} is forbidden from this tree.`);
  if (flagged !== ALLOWED) fail(`--project ${flagged} is not ${ALLOWED}`);
}

console.log(`DEPLOY GUARD: ok (${ALLOWED})`);
