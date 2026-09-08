/**
 * Strict AED string → integer fils. No floating-point money path.
 */
export function parseAedInputToFils(input) {
  if (input === null || input === undefined) return null;
  const text = String(input).trim().replace(/[٬,\s]/g, "");
  if (!text) return null;
  if (text.startsWith("-")) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;

  const [whole, frac = ""] = text.split(".");
  if (!/^\d+$/.test(whole)) return null;

  const wholeNum = Number(whole);
  const fracNum = Number((frac + "00").slice(0, 2));
  if (!Number.isFinite(wholeNum) || !Number.isFinite(fracNum)) return null;
  if (!Number.isSafeInteger(wholeNum) || !Number.isSafeInteger(fracNum)) return null;

  const fils = wholeNum * 100 + fracNum;
  if (!Number.isSafeInteger(fils) || fils <= 0) return null;
  return fils;
}
