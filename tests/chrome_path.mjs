import fs from "node:fs";
import { execSync } from "node:child_process";

export function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const found = execSync("command -v google-chrome-stable || command -v google-chrome || command -v chromium-browser || command -v chromium", { encoding: "utf8" }).trim().split("\n")[0];
    if (found) return found;
  } catch {}
  throw new Error("CHROME_NOT_FOUND");
}
