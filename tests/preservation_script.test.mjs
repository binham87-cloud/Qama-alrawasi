import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = new URL("../scripts/compare_exports.mjs", import.meta.url);
const envelope = (documents) => ({ format:"qama-firestore-backup-v1", documents });

test("مقارنة النسخ تسمح بالإضافة وتحافظ على كل القيم القديمة", () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"qama-preserve-"));
  const before=path.join(dir,"before.json"), after=path.join(dir,"after.json");
  fs.writeFileSync(before,JSON.stringify(envelope({"months/2026_3":{data:{transactions:[{id:1,amount:100}],note:"قديم"}}})));
  fs.writeFileSync(after, JSON.stringify(envelope({"months/2026_3":{data:{transactions:[{id:1,amount:100}],note:"قديم"},_rev:1},"ledger/new":{amount:100}})));
  assert.doesNotThrow(()=>execFileSync(process.execPath,[script.pathname,before,after],{stdio:"pipe"}));
});

test("مقارنة النسخ تفشل إذا اختفى حقل أو سجل قديم", () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"qama-preserve-"));
  const before=path.join(dir,"before.json"), after=path.join(dir,"after.json");
  fs.writeFileSync(before,JSON.stringify(envelope({"months/2026_3":{data:{transactions:[{id:1,amount:100}],note:"قديم"}}})));
  fs.writeFileSync(after, JSON.stringify(envelope({"months/2026_3":{data:{transactions:[]}}})));
  assert.throws(()=>execFileSync(process.execPath,[script.pathname,before,after],{stdio:"pipe"}));
});
