import process from "node:process";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { createPinRecord } from "../functions/pin_crypto.mjs";

const args = process.argv.slice(2);
const projectAt = args.indexOf("--project");
const projectId = projectAt >= 0 ? args[projectAt + 1] : "";
if (projectAt >= 0) args.splice(projectAt, 2);
const capsAt=args.indexOf("--capabilities");
const capsText=capsAt>=0?String(args[capsAt+1]||""):"";
if(capsAt>=0)args.splice(capsAt,2);
const [userKey, name, role = "employee"] = args;
if (!projectId || !/^[A-Za-z0-9_-]{1,40}$/.test(userKey || "") || !name || !["owner", "manager", "finance", "employee"].includes(role)) {
  console.error('الاستخدام: node scripts/set_pin.mjs --project PROJECT_ID [--capabilities deposits,showCollectionSummary,monthWindow=1] USER_KEY "الاسم" ROLE');
  process.exit(1);
}
if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
  console.error("يجب تشغيل الأمر من Terminal تفاعلي حتى لا يظهر PIN على الشاشة أو في سجل الأوامر.");
  process.exit(1);
}

function hiddenPin(label) {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdout.write(label);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (ch) => {
      if (ch === "\u0003") { cleanup(); reject(new Error("CANCELLED")); return; }
      if (ch === "\r" || ch === "\n") { cleanup(); process.stdout.write("\n"); resolve(value); return; }
      if (ch === "\u007f") { value = value.slice(0, -1); return; }
      if (/^\d$/.test(ch) && value.length < 4) value += ch;
    };
    const cleanup = () => { process.stdin.off("data", onData); process.stdin.setRawMode(false); process.stdin.pause(); };
    process.stdin.on("data", onData);
  });
}

const pin = await hiddenPin("PIN من 4 أرقام: ");
const confirm = await hiddenPin("أعد إدخال PIN: ");
if (!/^\d{4}$/.test(pin) || pin !== confirm) {
  console.error("PIN غير صالح أو غير متطابق.");
  process.exit(1);
}

initializeApp({ projectId });
const db = getFirestore();
const auth = getAuth();
const pinRef = db.collection("authPins").doc(userKey);
const old = await pinRef.get();
const uid = old.exists && old.data()?.uid ? String(old.data().uid) : `qama_${userKey}`;
try { await auth.getUser(uid); }
catch (e) {
  if (e.code !== "auth/user-not-found") throw e;
  await auth.createUser({ uid, displayName: name, disabled: false });
}

const pinRecord = createPinRecord(pin);
const capabilities={};
for(const raw of capsText.split(",").map(x=>x.trim()).filter(Boolean)){
  const [key,val]=raw.split("=");
  if(!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(key))throw new Error("BAD_CAPABILITY:"+key);
  capabilities[key]=val==null?true:Number(val);
  if(val!=null&&!Number.isFinite(capabilities[key]))throw new Error("BAD_CAPABILITY_VALUE:"+raw);
}
const batch = db.batch();
batch.set(db.collection("users").doc(uid), {
  userKey, name, role, active: true, capabilities, updatedAt: FieldValue.serverTimestamp()
}, { merge: true });
batch.set(pinRef, {
  uid, name, active: true,
  ...pinRecord,
  failedCount: 0, lockedUntil: null, updatedAt: FieldValue.serverTimestamp()
}, { merge: true });
await batch.commit();
console.log(`تم إعداد ${name} (${userKey}) بأمان. لم يُحفظ PIN الخام.`);
