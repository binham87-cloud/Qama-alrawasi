import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInWithCustomToken, signOut } from "firebase/auth";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";
import { firebaseConfig, USE_EMULATOR, EMULATOR_HOST, PROJECT_ID } from "./config.mjs";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const functions = getFunctions(app, "me-central1");

if (USE_EMULATOR) {
  connectAuthEmulator(auth, `http://${EMULATOR_HOST}:9099`, { disableWarnings: true });
  connectFunctionsEmulator(functions, EMULATOR_HOST, 5001);
}

export async function listLoginUsers() {
  const fn = httpsCallable(functions, "listLoginUsers");
  const { data } = await fn({});
  return data.users || [];
}

export async function login(userId, pin) {
  const fn = httpsCallable(functions, "login");
  const { data } = await fn({ userId, pin });
  await signInWithCustomToken(auth, data.customToken);
  return data.user;
}

export async function cmd(name, payload, operationId) {
  const fn = httpsCallable(functions, "command");
  const { data } = await fn({ name, payload, operationId });
  return data;
}

export async function readPeriod(period) {
  const fn = httpsCallable(functions, "read");
  const { data } = await fn({ period });
  return data;
}

export async function logout() {
  await signOut(auth);
}

export function newOperationId(prefix) {
  return `${prefix}:${crypto.randomUUID()}`;
}

export { auth, PROJECT_ID };
