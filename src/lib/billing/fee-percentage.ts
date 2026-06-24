/** Whole-number percent stored in DB (e.g. 10 = 10%). Matches computeFeeFromSchedule. */
export const FEE_PERCENTAGE_MAX = 99.9999;

export function parseFeePercentageInput(
  raw: string | undefined | null,
  field = "feePercentage"
): { ok: true; value: string } | { ok: false; message: string } {
  if (raw == null || raw === "") {
    return { ok: true, value: "0" };
  }
  const trimmed = raw.trim();
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, message: `${field} must be a non-negative number` };
  }
  if (n > FEE_PERCENTAGE_MAX) {
    return {
      ok: false,
      message: `${field} must be at most ${FEE_PERCENTAGE_MAX} (whole percent, e.g. 10 for 10%)`,
    };
  }
  return { ok: true, value: n.toFixed(4) };
}
