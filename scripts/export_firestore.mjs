import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { GeoPoint, Timestamp, getFirestore } from "firebase-admin/firestore";

const args = process.argv.slice(2);
const projectAt = args.indexOf("--project");
const outAt = args.indexOf("--out");
const projectId = projectAt >= 0 ? args[projectAt + 1] : "";
const output = outAt >= 0 ? args[outAt + 1] : "";
if (!projectId || !output) {
  console.error("الاستخدام: node scripts/export_firestore.mjs --project PROJECT_ID --out backup.json");
  process.exit(1);
}

function encode(value) {
  if (value instanceof Timestamp) return { __type: "timestamp", value: value.toDate().toISOString() };
  if (value instanceof GeoPoint) return { __type: "geopoint", latitude: value.latitude, longitude: value.longitude };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { __type: "bytes", value: Buffer.from(value).toString("base64") };
  if (value && typeof value === "object" && typeof value.path === "string" && value.firestore) return { __type: "reference", value: value.path };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, encode(value[k])]));
  return value;
}

let credential;
try {
  await applicationDefault().getAccessToken();
  credential = applicationDefault();
} catch {
  const firebaseConfigPath = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");
  const cliConfig = JSON.parse(await fs.readFile(firebaseConfigPath, "utf8"));
  const accessToken = cliConfig?.tokens?.access_token;
  if (!accessToken) throw new Error("GOOGLE_OR_FIREBASE_LOGIN_REQUIRED");
  credential = { async getAccessToken() { return { access_token: accessToken, expires_in: 3600 }; } };
}
initializeApp({ projectId, credential });
const db = getFirestore();
const documents = {};

async function walkCollection(col) {
  const snap = await col.get();
  for (const doc of snap.docs) {
    documents[doc.ref.path] = encode(doc.data());
    const children = await doc.ref.listCollections();
    for (const child of children) await walkCollection(child);
  }
}

const roots = await db.listCollections();
for (const root of roots.sort((a, b) => a.id.localeCompare(b.id))) await walkCollection(root);
const ordered = Object.fromEntries(Object.keys(documents).sort().map((k) => [k, documents[k]]));
const canonical = JSON.stringify(ordered);
const envelope = {
  format: "qama-firestore-backup-v1",
  projectId,
  exportedAt: new Date().toISOString(),
  documentCount: Object.keys(ordered).length,
  sha256: crypto.createHash("sha256").update(canonical).digest("hex"),
  documents: ordered
};
await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
await fs.writeFile(output, JSON.stringify(envelope, null, 2), { flag: "wx", mode: 0o600 });
console.log(`تم تصدير ${envelope.documentCount} مستند. SHA-256: ${envelope.sha256}`);
console.log(path.resolve(output));
