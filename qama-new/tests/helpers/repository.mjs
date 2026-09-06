/**
 * In-memory repository implementing the same facade as Firestore.
 * Aborts transactions when the read set changes before commit (J1–J3 semantics).
 */
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

const collections = new Map();

function col(name) {
  if (!collections.has(name)) collections.set(name, new Map());
  return collections.get(name);
}

export function resetRepository() {
  collections.clear();
}

function clone(v) {
  return v === undefined ? undefined : structuredClone(v);
}

function matches(doc, filters) {
  for (const [field, op, value] of filters) {
    if (op !== "==") throw new Error(`unsupported op ${op}`);
    if (doc[field] !== value) return false;
  }
  return true;
}

export function createMemoryRepository() {
  let version = 0;
  const readSets = new WeakMap();

  function snapshot() {
    const snap = new Map();
    for (const [name, map] of collections) {
      snap.set(name, new Map(map));
    }
    return snap;
  }

  function createTx(snap) {
    const reads = [];
    const writes = [];

    const tx = {
      async get(collection, id) {
        const map = snap.get(collection) || new Map();
        const doc = map.get(id);
        reads.push({ collection, id, versionAtRead: version });
        return doc ? clone(doc) : null;
      },
      create(collection, id, data) {
        const map = snap.get(collection) || new Map();
        if (map.has(id)) throw new Error(`ALREADY_EXISTS:${collection}/${id}`);
        writes.push({ type: "create", collection, id, data: clone(data) });
      },
      update(collection, id, patch) {
        const map = snap.get(collection) || new Map();
        if (!map.has(id)) throw new Error(`NOT_FOUND:${collection}/${id}`);
        writes.push({ type: "update", collection, id, patch: clone(patch) });
      },
      async query(collection, filters = []) {
        const map = snap.get(collection) || new Map();
        const out = [];
        for (const doc of map.values()) {
          if (matches(doc, filters)) out.push(clone(doc));
        }
        reads.push({ collection, filters, versionAtRead: version });
        return out;
      },
      async hashPin(pin) {
        const salt = randomBytes(16).toString("hex");
        const hash = scryptSync(String(pin), salt, 64).toString("hex");
        return { hash, salt };
      },
    };

    readSets.set(tx, { reads, writes, snap });
    return tx;
  }

  return {
    async runTransaction(fn) {
      for (let attempt = 0; attempt < 25; attempt++) {
        const snap = snapshot();
        const tx = createTx(snap);
        const result = await fn(tx);
        const meta = readSets.get(tx);

        for (const r of meta.reads) {
          if (r.id !== undefined) {
            const live = col(r.collection).get(r.id);
            const snapDoc = (snap.get(r.collection) || new Map()).get(r.id);
            if (JSON.stringify(live) !== JSON.stringify(snapDoc)) {
              throw new Error("TRANSACTION_CONFLICT");
            }
          } else {
            const live = [...col(r.collection).values()].filter((d) => matches(d, r.filters));
            const snapDocs = [...(snap.get(r.collection) || new Map()).values()].filter((d) => matches(d, r.filters));
            if (JSON.stringify(live) !== JSON.stringify(snapDocs)) {
              throw new Error("TRANSACTION_CONFLICT");
            }
          }
        }

        for (const w of meta.writes) {
          const map = col(w.collection);
          if (w.type === "create") {
            if (map.has(w.id)) throw new Error(`ALREADY_EXISTS:${w.collection}/${w.id}`);
            map.set(w.id, clone(w.data));
          } else {
            const cur = map.get(w.id);
            map.set(w.id, { ...cur, ...w.patch });
          }
        }
        version++;
        return result;
      }
      throw new Error("TRANSACTION_EXHAUSTED");
    },

    /** Direct seeding outside transactions (tests only). */
    seed(collection, id, data) {
      col(collection).set(id, clone(data));
    },

    dump(collection) {
      return [...col(collection).values()].map(clone);
    },

    async getUser(userId) {
      return clone(col("users").get(userId)) || null;
    },

    async listUsers() {
      return [...col("users").values()].map(clone);
    },

    async query(collection, filters = []) {
      return [...col(collection).values()].filter((d) => matches(d, filters)).map(clone);
    },
  };
}

export function verifyPin(pin, user) {
  if (!user?.pinHash || !user?.pinSalt) return false;
  const hash = scryptSync(String(pin), user.pinSalt, 64);
  const expected = Buffer.from(user.pinHash, "hex");
  if (expected.length !== hash.length) return false;
  return timingSafeEqual(hash, expected);
}
