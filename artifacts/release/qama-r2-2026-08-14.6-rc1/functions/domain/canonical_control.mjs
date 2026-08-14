// Internal gate only. Reconstruction is not a runtime product mode.
// Normal QAMA financial and operational commands always run.
// Reconstruction-admin commands are disabled, not gated by a control state.

const RECONSTRUCTION_COMMANDS = new Set([
  "createReconstructionPlan", "addReconstructionObligation", "cancelReconstructionObligation",
  "linkReconstructionObligationStructure", "confirmReconstructionStructure",
  "classifyHistoricalException", "removeHistoricalException", "materializeReconstructionCycles",
  "activateReconstructionPlan", "cancelReconstructionPlan", "abandonReconstructionAndActivate",
]);

export const CONTROL_STATES = Object.freeze({
  QAMA_ACTIVE: "QAMA_ACTIVE",
});

export function normalizeCanonicalControl(value) {
  const structuralPreparation = { enabled: false, monthKey: null, version: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { state: CONTROL_STATES.QAMA_ACTIVE, valid: false, structuralPreparation };
  }
  return {
    state: CONTROL_STATES.QAMA_ACTIVE,
    version: Number.isInteger(value.version) && value.version > 0 ? value.version : 1,
    valid: true,
    structuralPreparation,
    changedBy: value.changedBy || null,
    changedAt: value.changedAt || null,
  };
}

export function assertCanonicalCommandAllowed({ command }) {
  if (RECONSTRUCTION_COMMANDS.has(command)) throw new Error("RECONSTRUCTION_DISABLED");
  return { state: CONTROL_STATES.QAMA_ACTIVE, valid: true };
}

export function operationalWriteAllowed() {
  return true;
}
