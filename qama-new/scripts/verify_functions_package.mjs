#!/usr/bin/env node
/** Verifies functions/ deploy package imports resolve without ../src */
import { mkdtempSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "qama-fn-"));
try {
  cpSync("functions", join(dir, "functions"), { recursive: true });
  writeFileSync(join(dir, "functions", "package.json"), JSON.stringify({
    name: "qama-new-functions-verify",
    type: "module",
    main: "index.mjs",
    dependencies: { "firebase-admin": "^12.7.0", "firebase-functions": "^6.3.0" },
  }, null, 2));
  execSync("npm install --omit=dev", { cwd: join(dir, "functions"), stdio: "pipe" });
  execSync("node -e \"import('./index.mjs')\"", { cwd: join(dir, "functions"), stdio: "pipe" });
  console.log("FUNCTIONS_PACKAGE_OK");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
