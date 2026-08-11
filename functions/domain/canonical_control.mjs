export const CONTROL_STATES = Object.freeze({
  MAINTENANCE_LOCKED: "MAINTENANCE_LOCKED",
  STAGED_READ_ONLY: "STAGED_READ_ONLY",
  RECONSTRUCTION_ALLOWED: "RECONSTRUCTION_ALLOWED",
  ACTIVATION_REVIEW: "ACTIVATION_REVIEW",
  CANONICAL_ACTIVE: "CANONICAL_ACTIVE",
});

const KNOWN = new Set(Object.values(CONTROL_STATES));
const PLAN_ADMIN = new Set(["createReconstructionPlan", "addReconstructionObligation", "cancelReconstructionObligation", "linkReconstructionObligationStructure", "classifyHistoricalException", "removeHistoricalException", "materializeReconstructionCycles", "cancelReconstructionPlan"]);
const STRUCTURAL_CONFIRMATION = "confirmReconstructionStructure";
const STRUCTURAL_PREPARATION_COMMANDS = new Set(["createReconstructionPlan", "addReconstructionObligation", "cancelReconstructionObligation", "linkReconstructionObligationStructure", STRUCTURAL_CONFIRMATION, "materializeReconstructionCycles"]);

export function normalizeCanonicalControl(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { state: CONTROL_STATES.MAINTENANCE_LOCKED, valid: false };
  if (!KNOWN.has(value.state) || !Number.isInteger(value.version) || value.version < 1) return { state: CONTROL_STATES.MAINTENANCE_LOCKED, valid: false };
  const permit=value.structuralPreparation;
  const structuralPreparation=permit&&permit.enabled===true&&/^\d{4}_\d{1,2}$/.test(String(permit.monthKey||""))
    ? {enabled:true,monthKey:String(permit.monthKey),version:Number.isInteger(permit.version)&&permit.version>0?permit.version:1}
    : {enabled:false,monthKey:null,version:null};
  return { state: value.state, version: value.version, valid: true, structuralPreparation, changedBy: value.changedBy || null, changedAt: value.changedAt || null };
}

function reconstructionPlan(state, payload) {
  const direct = payload?.reconstructionPlanId && (state.reconstructionPlans || []).find((x) => x.id === payload.reconstructionPlanId);
  if (direct) return direct;
  for (const key of ["paymentIntents", "allocations", "depositRequests", "custodyTransfers", "expenses", "installments"]) {
    const found = (state[key] || []).find((x) => x.reconstructionPlanId);
    if (found) return (state.reconstructionPlans || []).find((x) => x.id === found.reconstructionPlanId) || null;
  }
  return null;
}

export function assertCanonicalCommandAllowed({ control, command, payload, state, actor }) {
  const gate = normalizeCanonicalControl(control);
  if (gate.state===CONTROL_STATES.MAINTENANCE_LOCKED) {
    if(!STRUCTURAL_PREPARATION_COMMANDS.has(command)||!gate.structuralPreparation?.enabled)throw new Error(`CANONICAL_WRITES_DENIED:${gate.state}`);
    if(command==="createReconstructionPlan"){
      if(!actor||!["owner","manager"].includes(actor.role))throw new Error("MANAGER_REQUIRED");
      if(String(payload?.monthKey||"")!==gate.structuralPreparation.monthKey)throw new Error("STRUCTURAL_PREPARATION_SCOPE_MISMATCH");
    }else{
      if(["addReconstructionObligation","cancelReconstructionObligation","linkReconstructionObligationStructure","materializeReconstructionCycles"].includes(command)&&(!actor||!["owner","manager"].includes(actor.role)))throw new Error("MANAGER_REQUIRED");
      const plan=reconstructionPlan(state,payload);
      if(!plan||plan.status!=="DRAFT"||plan.monthKey!==gate.structuralPreparation.monthKey)throw new Error("STRUCTURAL_PREPARATION_GATE_REQUIRED");
    }
    return gate;
  }
  if (gate.state===CONTROL_STATES.STAGED_READ_ONLY) throw new Error(`CANONICAL_WRITES_DENIED:${gate.state}`);
  if (["activateReconstructionPlan","abandonReconstructionAndActivate"].includes(command) && gate.state !== CONTROL_STATES.ACTIVATION_REVIEW) throw new Error("ACTIVATION_GATE_CLOSED");
  if(command==="abandonReconstructionAndActivate"&&(!actor||!["owner","manager"].includes(actor.role)))throw new Error("MANAGER_REQUIRED");
  if (gate.state === CONTROL_STATES.ACTIVATION_REVIEW && !["activateReconstructionPlan","abandonReconstructionAndActivate"].includes(command)) throw new Error("ACTIVATION_REVIEW_WRITE_DENIED");
  if (gate.state === CONTROL_STATES.RECONSTRUCTION_ALLOWED) {
    if (PLAN_ADMIN.has(command)) {
      if (!actor || !["owner", "manager"].includes(actor.role)) throw new Error("MANAGER_REQUIRED");
      return gate;
    }
    if (command === STRUCTURAL_CONFIRMATION) {
      const plan = reconstructionPlan(state, payload);
      if (!plan || plan.status !== "DRAFT") throw new Error("RECONSTRUCTION_GATE_REQUIRED");
      return gate;
    }
    const plan = reconstructionPlan(state, payload);
    if (!plan || plan.status !== "DRAFT") throw new Error("RECONSTRUCTION_GATE_REQUIRED");
    const cycleId=String(payload?.cycleId||"");
    if(cycleId){
      const obligation=(plan.reviewedObligations||[]).find(x=>String(x.cycleId||x.id)===cycleId);
      if(!obligation||obligation.structuralStatus!=="READY_FOR_RECONSTRUCTION")throw new Error("OBLIGATION_STRUCTURAL_CONFIRMATION_REQUIRED");
    }
  }
  if (gate.state === CONTROL_STATES.CANONICAL_ACTIVE && (PLAN_ADMIN.has(command) || ["activateReconstructionPlan","abandonReconstructionAndActivate"].includes(command))) throw new Error("RECONSTRUCTION_CONTROL_DENIED_WHILE_ACTIVE");
  if(command==="createRentalCycle"&&gate.state!==CONTROL_STATES.CANONICAL_ACTIVE)throw new Error("CANONICAL_CYCLE_CREATION_GATE_CLOSED");
  return gate;
}

export function operationalWriteAllowed(control) {
  return normalizeCanonicalControl(control).state === CONTROL_STATES.CANONICAL_ACTIVE;
}
