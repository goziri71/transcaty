import { z } from "zod";
import { merchantApiErrorResponse, merchantApiFacingError } from "./merchant-api-zod.js";

/**
 * Tylt merchant GET proxies return upstream JSON verbatim on success (`200`).
 * Errors use Transacty-normalized status codes (`502` when upstream ≥ 500).
 */
export const tyltMerchantProxyResponses = {
  200: z.unknown(),
  400: merchantApiFacingError,
  401: merchantApiErrorResponse,
  403: merchantApiErrorResponse,
  404: merchantApiErrorResponse,
  502: merchantApiFacingError,
  500: merchantApiFacingError,
};

export const tyltPassthroughQuerySchema = z.object({}).passthrough();

export const tyltRowsPageQuerySchema = z.object({
  rows: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

export const tyltTransactionIdParamSchema = z.object({
  transactionId: z.string().uuid(),
});
