import crypto from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { normalizeCanonicalControl, CONTROL_STATES } from "./domain/canonical_control.mjs";
import { buildLegacyStructuralBootstrapPlan, entityBootstrapFingerprint } from "./domain/legacy_structural_bootstrap.mjs";

export const STRUCTURAL_COLLECTIONS = Object.freeze({
  properties: "properties", units: "units", spaces: "rentableSpaces",
  tenants: "tenants", tenancies: "tenancies", cycles: "rentalCycles",
});

const COMMANDS = new Set([
  "createProperty", "updateProperty", "setPropertyActive",
  "createUnit", "updateUnit", "setUnitActive",
  "createRentableSpace", "updateRentableSpace", "setRentableSpaceActive",
  "createTenant", "updateTenant", "setTenantActive",
  "createTenancy", "endTenancy", "replaceTenancyTenant",
  "createRentalCycle", "renewRentalCycle", "correctRentalCycle", "endRentalCycle", "cancelRentalCycle",
  "bootstrapLegacyPhysicalStructure",
]);
const MANAGER_ROLES = new Set(["owner", "manager"]);
const ID = /^[A-Za-z0-9:_-]{3,160}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}_\d{1,2}$/;
const clone = (x) => structuredClone(x);
const hash = (x) => crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
const nowMonth = (date) => `${date.slice(0,4)}_${Number(date.slice(5,7))-1}`;
const requiredId = (value, name) => { const out=String(value||""); if(!ID.test(out))throw new Error(`${name}_INVALID`);return out; };
const requiredText = (value, name, max=240) => { const out=String(value||"").trim();if(!out||out.length>max)throw new Error(`${name}_INVALID`);return out; };
const optionalText = (value, max=500) => { const out=String(value||"").trim();if(out.length>max)throw new Error("TEXT_TOO_LONG");return out; };
const requiredDate = (value, name) => { const out=String(value||"");if(!DATE.test(out)||Number.isNaN(Date.parse(`${out}T00:00:00Z`)))throw new Error(`${name}_INVALID`);return out; };
const positiveMoney = (value) => { if(!Number.isSafeInteger(value)||value<=0)throw new Error("CONTRACTUAL_AMOUNT_INVALID");return value; };
const ref = (db,key,id) => db.collection(STRUCTURAL_COLLECTIONS[key]).doc(id);
async function read(tx,db,key,id,active=false){const snap=await tx.get(ref(db,key,id));if(!snap.exists)throw new Error(`${key.toUpperCase()}_NOT_FOUND`);const data={id:snap.id,...snap.data()};if(active&&data.status!=="active")throw new Error(`${key.toUpperCase()}_INACTIVE`);return data;}
async function absent(tx,db,key,id){if((await tx.get(ref(db,key,id))).exists)throw new Error(`${key.toUpperCase()}_EXISTS`);}
async function conflict(tx,query,code){if(!(await tx.get(query.limit(1))).empty)throw new Error(code);}
async function cycleConflict(tx,db,tenancyId,reportingMonth){const snap=await tx.get(db.collection("rentalCycles").where("tenancyId","==",tenancyId));if(snap.docs.some(d=>["open","active"].includes(String(d.data().status||""))&&d.data().reportingMonth===reportingMonth))throw new Error("ACTIVE_CYCLE_CONFLICT");}
function base(id,actor,now,origin="normal"){return {id,status:"active",origin,createdBy:actor.id,createdByUid:actor.uid,createdAt:now,updatedAt:now,version:1};}
function audit(db,tx,{operationId,command,actor,now,entityType,entityId,before=null,after,reason=""}){tx.create(db.collection("auditEvents").doc(`structural:${operationId}`),{operationId,action:`structural.${command}`,actorUid:actor.uid,actorId:actor.id,entityType,entityId,before,after,reason,createdAt:now,schemaVersion:3});}

async function executeLegacyStructuralBootstrap(db,tx,p,actor,now,operationId,planDoc){
  const sourceMonthKey=String(p.sourceMonthKey||"");if(!MONTH.test(sourceMonthKey))throw new Error("SOURCE_MONTH_INVALID");
  if(String(planDoc?.monthKey||"")!==sourceMonthKey)throw new Error("RECONSTRUCTION_SCOPE_MISMATCH");
  const sourcePath=`months/${sourceMonthKey}`;const sourceSnap=await tx.get(db.doc(sourcePath));if(!sourceSnap.exists)throw new Error("LEGACY_SOURCE_NOT_FOUND");
  const sourceWrapper=sourceSnap.data()||{};const legacyMonthData=sourceWrapper.data||sourceWrapper;
  const plan=buildLegacyStructuralBootstrapPlan({legacyMonthData,sourceDocumentPath:sourcePath,property:p.property});
  if(p.expectedSourceStructureHash&&String(p.expectedSourceStructureHash)!==plan.sourceStructureHash)throw new Error("LEGACY_STRUCTURE_HASH_MISMATCH");
  const ordered=[
    ...plan.entities.properties.map(entity=>({collection:"properties",entity})),
    ...plan.entities.units.map(entity=>({collection:"units",entity})),
    ...plan.entities.rentableSpaces.map(entity=>({collection:"rentableSpaces",entity})),
  ];
  const existing=await Promise.all(ordered.map(({collection,entity})=>tx.get(db.collection(collection).doc(entity.id))));
  const created=[];const unchanged=[];
  for(let index=0;index<ordered.length;index++){
    const {collection,entity}=ordered[index],snap=existing[index];
    if(snap.exists){
      if(entityBootstrapFingerprint(snap.data())!==entityBootstrapFingerprint(entity))throw new Error(`STRUCTURAL_BOOTSTRAP_CONFLICT:${collection}:${entity.id}`);
      unchanged.push(`${collection}/${entity.id}`);continue;
    }
    const after={...clone(entity),status:"active",origin:"reconstruction",reconstructionPlanId:String(p.reconstructionPlanId),createdBy:actor.id,createdByUid:actor.uid,createdAt:now,updatedAt:now,updatedBy:actor.id,version:1,schemaVersion:3};
    tx.create(db.collection(collection).doc(entity.id),after);
    const auditId=`structural-bootstrap:${operationId}:${hash(`${collection}/${entity.id}`).slice(0,20)}`;
    tx.create(db.collection("auditEvents").doc(auditId),{operationId,action:"structural.bootstrap_legacy_physical_structure",actorUid:actor.uid,actorId:actor.id,entityType:collection,entityId:entity.id,before:null,after,sourceReference:entity.sourceReference,sourceRecordHash:entity.sourceRecordHash,reconstructionPlanId:String(p.reconstructionPlanId),createdAt:now,schemaVersion:3});
    created.push(`${collection}/${entity.id}`);
  }
  return {command:"bootstrapLegacyPhysicalStructure",sourceDocumentPath:sourcePath,sourceStructureHash:plan.sourceStructureHash,bootstrapKey:plan.bootstrapKey,created,unchanged,skipped:plan.skipped,conflicts:plan.conflicts,counts:plan.counts,financialEffect:plan.financialEffect};
}

async function execute(db,tx,command,p,actor,now,operationId){
  const reason=optionalText(p.reason||p.sourceReference||"",1000); let before=null,after=null,key="",id="";
  if(command==="createProperty"){
    key="properties";id=requiredId(p.propertyId,"PROPERTY_ID");await absent(tx,db,key,id);
    after={...base(id,actor,now,p.origin),name:requiredText(p.name,"PROPERTY_NAME"),code:optionalText(p.code,80),address:optionalText(p.address,500),metadata:clone(p.metadata||{})};
  } else if(command==="updateProperty"||command==="setPropertyActive"){
    key="properties";id=requiredId(p.propertyId,"PROPERTY_ID");before=await read(tx,db,key,id);after={...before};
    if(command==="updateProperty"){if(p.name!==undefined)after.name=requiredText(p.name,"PROPERTY_NAME");if(p.address!==undefined)after.address=optionalText(p.address,500);if(p.metadata!==undefined)after.metadata=clone(p.metadata||{});}
    else after.status=p.active===true?"active":"inactive";
  } else if(command==="createUnit"){
    key="units";id=requiredId(p.unitId,"UNIT_ID");const property=await read(tx,db,"properties",requiredId(p.propertyId,"PROPERTY_ID"),true);await absent(tx,db,key,id);
    after={...base(id,actor,now,p.origin),propertyId:property.id,name:requiredText(p.name,"UNIT_NAME"),unitType:optionalText(p.unitType||"standard",80),metadata:clone(p.metadata||{})};
  } else if(command==="updateUnit"||command==="setUnitActive"){
    key="units";id=requiredId(p.unitId,"UNIT_ID");before=await read(tx,db,key,id);after={...before};
    if(command==="updateUnit"){if(p.name!==undefined)after.name=requiredText(p.name,"UNIT_NAME");if(p.unitType!==undefined)after.unitType=optionalText(p.unitType,80);if(p.metadata!==undefined)after.metadata=clone(p.metadata||{});}
    else {if(p.active===false){await conflict(tx,db.collection("tenancies").where("unitId","==",id).where("status","==","active"),"UNIT_HAS_ACTIVE_TENANCY");}after.status=p.active===true?"active":"inactive";}
  } else if(command==="createRentableSpace"){
    key="spaces";id=requiredId(p.spaceId,"SPACE_ID");const unit=await read(tx,db,"units",requiredId(p.unitId,"UNIT_ID"),true);await absent(tx,db,key,id);
    after={...base(id,actor,now,p.origin),propertyId:unit.propertyId,unitId:unit.id,name:requiredText(p.name,"SPACE_NAME"),spaceType:["full_unit","partition","room","other"].includes(p.spaceType)?p.spaceType:"other",metadata:clone(p.metadata||{})};
  } else if(command==="updateRentableSpace"||command==="setRentableSpaceActive"){
    key="spaces";id=requiredId(p.spaceId,"SPACE_ID");before=await read(tx,db,key,id);after={...before};
    if(command==="updateRentableSpace"){if(p.name!==undefined)after.name=requiredText(p.name,"SPACE_NAME");if(p.metadata!==undefined)after.metadata=clone(p.metadata||{});}
    else {if(p.active===false)await conflict(tx,db.collection("tenancies").where("spaceId","==",id).where("status","==","active"),"SPACE_HAS_ACTIVE_TENANCY");after.status=p.active===true?"active":"inactive";}
  } else if(command==="createTenant"){
    key="tenants";id=requiredId(p.tenantId,"TENANT_ID");await absent(tx,db,key,id);after={...base(id,actor,now,p.origin),displayName:requiredText(p.displayName,"TENANT_NAME"),identityReference:optionalText(p.identityReference,160),phone:optionalText(p.phone,40),metadata:clone(p.metadata||{})};
  } else if(command==="updateTenant"||command==="setTenantActive"){
    key="tenants";id=requiredId(p.tenantId,"TENANT_ID");before=await read(tx,db,key,id);after={...before};
    if(command==="updateTenant"){if(p.displayName!==undefined)after.displayName=requiredText(p.displayName,"TENANT_NAME");if(p.identityReference!==undefined)after.identityReference=optionalText(p.identityReference,160);if(p.phone!==undefined)after.phone=optionalText(p.phone,40);if(p.metadata!==undefined)after.metadata=clone(p.metadata||{});}
    else {if(p.active===false)await conflict(tx,db.collection("tenancies").where("tenantId","==",id).where("status","==","active"),"TENANT_HAS_ACTIVE_TENANCY");after.status=p.active===true?"active":"inactive";}
  } else if(command==="createTenancy"){
    key="tenancies";id=requiredId(p.tenancyId,"TENANCY_ID");const tenant=await read(tx,db,"tenants",requiredId(p.tenantId,"TENANT_ID"),true);const space=await read(tx,db,"spaces",requiredId(p.spaceId,"SPACE_ID"),true);const unit=await read(tx,db,"units",space.unitId,true);await read(tx,db,"properties",unit.propertyId,true);await absent(tx,db,key,id);
    await conflict(tx,db.collection("tenancies").where("spaceId","==",space.id).where("status","==","active"),"SPACE_TENANCY_CONFLICT");
    const startDate=requiredDate(p.startDate,"START_DATE");const endDate=p.endDate?requiredDate(p.endDate,"END_DATE"):null;if(endDate&&endDate<startDate)throw new Error("TENANCY_DATE_RANGE_INVALID");
    after={...base(id,actor,now,p.origin),propertyId:unit.propertyId,unitId:unit.id,spaceId:space.id,tenantId:tenant.id,startDate,endDate,sourceReference:optionalText(p.sourceReference,500)};
  } else if(command==="endTenancy"){
    key="tenancies";id=requiredId(p.tenancyId,"TENANCY_ID");before=await read(tx,db,key,id,true);const endDate=requiredDate(p.endDate,"END_DATE");if(endDate<before.startDate)throw new Error("TENANCY_DATE_RANGE_INVALID");after={...before,status:"ended",endDate};
  } else if(command==="replaceTenancyTenant"){
    const old=await read(tx,db,"tenancies",requiredId(p.tenancyId,"TENANCY_ID"),true);const replacementId=requiredId(p.newTenancyId,"NEW_TENANCY_ID");const tenant=await read(tx,db,"tenants",requiredId(p.tenantId,"TENANT_ID"),true);await absent(tx,db,"tenancies",replacementId);const effectiveDate=requiredDate(p.effectiveDate,"EFFECTIVE_DATE");if(effectiveDate<old.startDate)throw new Error("TENANCY_DATE_RANGE_INVALID");
    before=old;const ended={...old,status:"ended",endDate:effectiveDate,updatedAt:now,updatedBy:actor.id,version:Number(old.version||0)+1,replacedByTenancyId:replacementId};tx.set(ref(db,"tenancies",old.id),ended,{merge:false});
    key="tenancies";id=replacementId;after={...base(id,actor,now,p.origin),propertyId:old.propertyId,unitId:old.unitId,spaceId:old.spaceId,tenantId:tenant.id,startDate:effectiveDate,endDate:null,replacesTenancyId:old.id,sourceReference:optionalText(p.sourceReference,500)};
  } else if(["createRentalCycle","renewRentalCycle"].includes(command)){
    key="cycles";id=requiredId(p.cycleId,"CYCLE_ID");const tenancy=await read(tx,db,"tenancies",requiredId(p.tenancyId,"TENANCY_ID"),true);const tenant=await read(tx,db,"tenants",tenancy.tenantId,true);const space=await read(tx,db,"spaces",tenancy.spaceId,true);const unit=await read(tx,db,"units",tenancy.unitId,true);const property=await read(tx,db,"properties",tenancy.propertyId,true);await absent(tx,db,key,id);
    if(p.tenantId&&p.tenantId!==tenant.id)throw new Error("TENANCY_TENANT_MISMATCH");if(p.spaceId&&p.spaceId!==space.id)throw new Error("TENANCY_SPACE_MISMATCH");
    const startDate=requiredDate(p.startDate,"CYCLE_START_DATE"),dueDate=requiredDate(p.dueDate,"DUE_DATE");if(dueDate<startDate)throw new Error("CYCLE_DATE_RANGE_INVALID");
    if(command==="renewRentalCycle"){const prior=await read(tx,db,key,requiredId(p.previousCycleId,"PREVIOUS_CYCLE_ID"));if(prior.tenancyId!==tenancy.id)throw new Error("RENEWAL_TENANCY_MISMATCH");if(["cancelled"].includes(prior.status))throw new Error("CYCLE_NOT_RENEWABLE");}
    const reportingMonth=String(p.reportingMonth||nowMonth(dueDate));if(!MONTH.test(reportingMonth))throw new Error("REPORTING_MONTH_INVALID");
    await cycleConflict(tx,db,tenancy.id,reportingMonth);
    after={...base(id,actor,now,p.origin),propertyId:property.id,unitId:unit.id,spaceId:space.id,partitionId:space.spaceType==="partition"?space.id:null,tenantId:tenant.id,tenancyId:tenancy.id,startDate,dueDate,reportingMonth,baseAmountFils:positiveMoney(p.contractualAmountFils),sourceReference:optionalText(p.sourceReference,500),financialVersion:0,status:"open",previousCycleId:command==="renewRentalCycle"?p.previousCycleId:null};
  } else if(command==="correctRentalCycle"){
    key="cycles";id=requiredId(p.cycleId,"CYCLE_ID");before=await read(tx,db,key,id);if(Number(before.settledAmountFils||0)>0||Number(before.allocatedAmountFils||0)>0)throw new Error("SETTLED_CYCLE_REQUIRES_ADJUSTMENT_EVENT");after={...before};
    if(p.contractualAmountFils!==undefined)after.baseAmountFils=positiveMoney(p.contractualAmountFils);if(p.dueDate!==undefined)after.dueDate=requiredDate(p.dueDate,"DUE_DATE");after.correctionReason=requiredText(p.reason,"CORRECTION_REASON",1000);
  } else if(command==="endRentalCycle"||command==="cancelRentalCycle"){
    key="cycles";id=requiredId(p.cycleId,"CYCLE_ID");before=await read(tx,db,key,id);if(command==="cancelRentalCycle"&&Number(before.settledAmountFils||0)>0)throw new Error("SETTLED_CYCLE_CANNOT_CANCEL");after={...before,status:command==="cancelRentalCycle"?"cancelled":"expired",endedAt:requiredDate(p.effectiveDate,"EFFECTIVE_DATE")};
  } else throw new Error("UNKNOWN_STRUCTURAL_COMMAND");
  after={...after,updatedAt:now,updatedBy:actor.id,version:before?Number(before.version||0)+1:Number(after.version||1),schemaVersion:3};tx.set(ref(db,key,id),after,{merge:false});audit(db,tx,{operationId,command,actor,now,entityType:key,entityId:id,before,after,reason});return {command,entityType:key,entityId:id,status:after.status,version:after.version};
}

function publicError(error){const code=String(error?.message||"STRUCTURAL_COMMAND_FAILED");if(/REQUIRED|DENIED|GATE|INACTIVE|CONFLICT/.test(code))return new HttpsError("permission-denied",code);if(/NOT_FOUND/.test(code))return new HttpsError("not-found",code);if(/MISMATCH|RANGE|REQUIRES|CANNOT|EXISTS/.test(code))return new HttpsError("failed-precondition",code);return new HttpsError("invalid-argument",code);}

export function buildStructuralCommand(db){return onCall({enforceAppCheck:false},async request=>{if(!request.auth?.uid)throw new HttpsError("unauthenticated","AUTH_REQUIRED");const command=String(request.data?.command||"");const operationId=String(request.data?.operationId||"");const payload=request.data?.payload||{};if(!COMMANDS.has(command))throw new HttpsError("invalid-argument","UNKNOWN_STRUCTURAL_COMMAND");if(!ID.test(operationId))throw new HttpsError("invalid-argument","OPERATION_ID_INVALID");const payloadHash=hash({command,payload});try{return await db.runTransaction(async tx=>{const [userSnap,controlSnap,opSnap]=await Promise.all([tx.get(db.collection("users").doc(request.auth.uid)),tx.get(db.collection("config").doc("canonicalControl")),tx.get(db.collection("structuralOperations").doc(operationId))]);if(!userSnap.exists)throw new Error("PROFILE_MISSING");const profile=userSnap.data()||{};if(profile.active===false||!MANAGER_ROLES.has(String(profile.role||"")))throw new Error("MANAGER_REQUIRED");const control=normalizeCanonicalControl(controlSnap.exists?controlSnap.data():null);if(!control.valid)throw new Error("STRUCTURAL_ADMIN_GATE_CLOSED");let reconstructionPlan=null;if(control.state!==CONTROL_STATES.CANONICAL_ACTIVE){if(control.state!==CONTROL_STATES.RECONSTRUCTION_ALLOWED||payload.origin!=="reconstruction"||!payload.reconstructionPlanId)throw new Error("STRUCTURAL_ADMIN_GATE_CLOSED");const planSnap=await tx.get(db.collection("reconstructionPlans").doc(String(payload.reconstructionPlanId)));if(!planSnap.exists||planSnap.data().status!=="DRAFT")throw new Error("RECONSTRUCTION_GATE_REQUIRED");reconstructionPlan={id:planSnap.id,...planSnap.data()};}else if(command==="bootstrapLegacyPhysicalStructure")throw new Error("STRUCTURAL_BOOTSTRAP_RECONSTRUCTION_ONLY");if(opSnap.exists){const prior=opSnap.data()||{};if(prior.payloadHash!==payloadHash)throw new Error("IDEMPOTENCY_PAYLOAD_MISMATCH");return {...prior.result,replay:true};}const actor={uid:request.auth.uid,id:String(profile.userKey||request.auth.uid),role:String(profile.role)};const now=new Date().toISOString();const result=command==="bootstrapLegacyPhysicalStructure"?await executeLegacyStructuralBootstrap(db,tx,payload,actor,now,operationId,reconstructionPlan):await execute(db,tx,command,payload,actor,now,operationId);tx.create(db.collection("structuralOperations").doc(operationId),{operationId,command,payloadHash,actorUid:actor.uid,actorId:actor.id,result,status:"completed",createdAt:FieldValue.serverTimestamp(),schemaVersion:3});return {...result,replay:false};});}catch(error){throw publicError(error);}});}

export const structuralCommands=Object.freeze([...COMMANDS]);
