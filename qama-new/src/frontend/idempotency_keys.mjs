/**
 * Pure operationId helpers for the Old-UI bridge.
 * Extracted so Node can prove cycle uniqueness without Firebase.
 */

/** Compact obligation id for opKeys without truncating the distinguishing suffix. */
export function shortOb(ob) {
  const s = String(ob || "");
  if (s.length <= 48) return s.replace(/[^A-Za-z0-9_:.-]/g, "");
  // Keep head + tail so period/suffix survive.
  return (s.slice(0, 24) + "_" + s.slice(-20)).replace(/[^A-Za-z0-9_:.-]/g, "");
}

export function receiptCounts(receipts) {
  const list = Array.isArray(receipts) ? receipts : [];
  let live = 0;
  let all = list.length;
  for (const r of list) {
    if (r && (r.state === "recognized" || r.state === "pending")) live++;
  }
  return { live, all };
}

/**
 * Collection key: stable for retries of the same want/delta/generation,
 * distinct after reverse+recollect (all count grows; live count returns).
 */
export function collectionOpKey({ obligationId, wantFils, deltaFils, receipts }) {
  const { live, all } = receiptCounts(receipts);
  const key = `pay-${shortOb(obligationId)}-w${wantFils}-d${deltaFils}-L${live}-A${all}`;
  if (key.length > 120) throw new Error("OP_KEY_TOO_LONG:" + key.length);
  return key;
}

/**
 * Uncollect key: must change across collect→uncollect→collect→uncollect
 * even when paid amount (already) is identical.
 * Uses live+all receipt counts — reversed receipts remain in the list.
 */
export function uncollectOpKey({ obligationId, alreadyFils, receipts }) {
  const { live, all } = receiptCounts(receipts);
  // Fallback when client has no receipt list: include a nonce slot caller must fill.
  if (!Array.isArray(receipts)) {
    throw new Error("RECEIPTS_REQUIRED_FOR_UNCOLLECT_KEY");
  }
  const key = `uncol-${shortOb(obligationId)}-p${alreadyFils}-L${live}-A${all}`;
  if (key.length > 120) throw new Error("OP_KEY_TOO_LONG:" + key.length);
  return key;
}

/** Simulate bridge generations across collect/uncollect cycles. */
export function simulateCollectUncollectCycles(obligationId, amountFils, cycles = 2) {
  const receipts = [];
  const keys = { pay: [], uncol: [] };
  for (let c = 0; c < cycles; c++) {
    const pay = collectionOpKey({
      obligationId, wantFils: amountFils, deltaFils: amountFils, receipts: [...receipts],
    });
    keys.pay.push(pay);
    receipts.push({ id: `rcpt-${c}`, state: "recognized", amountFils });
    const uncol = uncollectOpKey({
      obligationId, alreadyFils: amountFils, receipts: [...receipts],
    });
    keys.uncol.push(uncol);
    // uncollect reverses all live → state reversed (still in list)
    for (const r of receipts) {
      if (r.state === "recognized") r.state = "reversed";
    }
  }
  return { keys, receipts };
}
