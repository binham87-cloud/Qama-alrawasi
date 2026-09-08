/**
 * Firestore repository facade.
 *
 * The command layer only ever sees get / query / create / update inside a transaction.
 * Swapping this implementation for the in-memory test double changes nothing above it,
 * so the code under test is the code that ships.
 */
import crypto from "node:crypto";
import { getFirestore } from "firebase-admin/firestore";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPinWith(pin, salt, keylen = SCRYPT.keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pin), salt, keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
      (err, key) => (err ? reject(err) : resolve(key.toString("hex"))));
  });
}

/** Existing production hashes used keylen 64 (128 hex chars). New hashes use keylen 32. */
export function keylenForStoredHash(hash) {
  return String(hash || "").length === 128 ? 64 : SCRYPT.keylen;
}
export async function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { hash: await hashPinWith(pin, salt), salt };
}
/** Constant-time compare so a wrong PIN cannot be discovered by timing. */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function createFirestoreRepository(db) {
  return {
    async runTransaction(fn) {
      return db.runTransaction(async (tx) => {
        const writes = [];
        const api = {
          hashPin,
          async get(collection, id) {
            const snap = await tx.get(db.collection(collection).doc(String(id)));
            return snap.exists ? { id: snap.id, ...snap.data() } : null;
          },
          async query(collection, wheres) {
            let q = db.collection(collection);
            for (const [field, op, value] of wheres) q = q.where(field, op, value);
            const snap = await tx.get(q);
            return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          },
          create(collection, id, data) { writes.push(["create", collection, String(id), data]); },
          update(collection, id, patch) { writes.push(["update", collection, String(id), patch]); },
        };
        const result = await fn(api);
        for (const [kind, collection, id, data] of writes) {
          const ref = db.collection(collection).doc(id);
          if (kind === "create") tx.create(ref, data);
          else tx.update(ref, data);
        }
        return result;
      });
    },
  };
}

/**
 * Emulator/seed helper.
 * Prefer createFirestoreRepository(getFirestore()) from the SAME firebase-admin
 * instance that called initializeApp (root vs functions/node_modules diverge).
 * Passing a Firestore instance is required when Admin was initialized elsewhere.
 */
export function getDb(firestoreOrProjectId) {
  if (firestoreOrProjectId && typeof firestoreOrProjectId.collection === "function") {
    return createFirestoreRepository(firestoreOrProjectId);
  }
  // Last resort — only works if this module's firebase-admin is the initialized one.
  return createFirestoreRepository(getFirestore());
}
