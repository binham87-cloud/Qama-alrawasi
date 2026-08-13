import crypto from "node:crypto";

const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((k)=>`${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}` : JSON.stringify(value);
const digest = (value) => crypto.createHash("sha256").update(stable(value)).digest("hex");

export function buildDeltaBridge(snapshotDocuments, cutoverDocuments, boundary) {
  const before = new Map(snapshotDocuments.map((d)=>[d.sourceLegacyId, digest(d)]));
  const mutations = cutoverDocuments.filter((d)=>before.get(d.sourceLegacyId) !== digest(d)).map((d)=>({
    id: `delta_${digest({ boundary, sourceLegacyId: d.sourceLegacyId, sourceHash: digest(d) }).slice(0,32)}`,
    sourceLegacyId: d.sourceLegacyId, sourceHash: digest(d), boundary, payload: d,
  })).sort((a,b)=>a.id.localeCompare(b.id));
  return { boundary, snapshotCount: snapshotDocuments.length, cutoverCount: cutoverDocuments.length, mutations, reconciliationHash: digest(mutations) };
}

export function applyDeltaExactlyOnce(existing, bridge) {
  const next = new Map(existing);
  for (const mutation of bridge.mutations) {
    const prior = next.get(mutation.id);
    if (prior && stable(prior) !== stable(mutation)) throw new Error(`DELTA_ID_CONFLICT:${mutation.id}`);
    next.set(mutation.id, mutation);
  }
  return next;
}

export function exportPostLiveCanonical(events, cutoverVersion) {
  return events.filter((event)=>event.cutoverVersion === cutoverVersion).map((event)=>({ ...event, rollbackExportId: `postlive_${digest(event).slice(0,32)}` }));
}
