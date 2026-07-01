/**
 * Platform merchant and wallets for fee collection.
 * BDT wallet seeded in migration 0010; BRL wallets in 0025.
 */
export const PLATFORM_MERCHANT_ID = "00000000-0000-0000-0000-000000000001" as const;

/** Legacy BDT test platform wallet (migration 0010). */
export const PLATFORM_WALLET_ID = "00000000-0000-0000-0000-000000000002" as const;
