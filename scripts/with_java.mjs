import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (!args.length) throw new Error("COMMAND_REQUIRED");

const env = { ...process.env };
const localHome = path.resolve(".local-tools/jre/Contents/Home");
if (fs.existsSync(path.join(localHome, "bin", "java"))) {
  env.JAVA_HOME = localHome;
  env.PATH = `${path.join(localHome, "bin")}${path.delimiter}${env.PATH || ""}`;
}

const probe = spawnSync("java", ["-version"], { env, stdio: "ignore" });
if (probe.status !== 0) {
  console.error("Java 21+ is required for Firebase Emulator tests. Set JAVA_HOME or install a JDK.");
  process.exit(2);
}

const result = spawnSync(args[0], args.slice(1), { env, stdio: "inherit", shell: false });
process.exit(result.status ?? 1);
