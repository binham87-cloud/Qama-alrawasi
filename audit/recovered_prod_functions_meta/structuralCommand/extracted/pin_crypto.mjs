import crypto from "node:crypto";

export function createPinRecord(pin, iterations = 210000) {
  if (!/^\d{4}$/.test(String(pin))) throw new Error("PIN_INVALID");
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(String(pin), salt, iterations, 32, "sha256");
  return { pinSalt: salt.toString("hex"), pinHash: hash.toString("hex"), pinIterations: iterations };
}

export function verifyPin(pin, record) {
  const iterations = Number(record.pinIterations);
  if (!Number.isInteger(iterations) || iterations < 100000) return false;
  if (!/^[a-f0-9]{32}$/i.test(String(record.pinSalt || ""))) return false;
  if (!/^[a-f0-9]{64}$/i.test(String(record.pinHash || ""))) return false;
  const actual = crypto.pbkdf2Sync(String(pin), Buffer.from(record.pinSalt, "hex"), iterations, 32, "sha256");
  const expected = Buffer.from(record.pinHash, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}
