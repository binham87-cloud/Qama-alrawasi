/**
 * Occupancy and financial status are separate editor controls.
 * The selected month must not change which controls exist.
 * فارغ is occupancy. It is not a financial status.
 */

export const OCCUPANCY_OPTIONS = Object.freeze([
  ["rented", "مؤجر"],
  ["vacant", "فارغ"],
  ["staff", "موظفين"],
]);

export const FINANCIAL_STATUS_OPTIONS = Object.freeze([
  ["collected", "محصّل"],
  ["pending", "غير مستحق"],
  ["late", "متأخر"],
]);

export function occupancyValue(status) {
  if (status === "vacant" || status === "staff") return status;
  return "rented";
}

/**
 * Same controls for every month and for both partitioned spaces and whole apartments.
 * `period` is accepted so callers cannot invent a month-specific editor by omission.
 */
export function editorControls({ kind = "partition", period = "" } = {}) {
  void kind;
  void period;
  return {
    occupancy: OCCUPANCY_OPTIONS,
    financial: FINANCIAL_STATUS_OPTIONS,
  };
}
