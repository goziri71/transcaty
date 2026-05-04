import { z } from "zod";

/** Standard `{ error, message? }` — matches merchant auth failures and simple validation errors. */
export const merchantApiErrorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

/** Merchant-safe failure body (no upstream leakage); optional machine-readable `code`. */
export const merchantApiFacingError = z.object({
  error: z.string(),
  message: z.string().optional(),
  code: z.string().optional(),
  transactionId: z.string().optional(),
  reference: z.string().optional(),
  platformOrderId: z.string().nullable().optional(),
});
