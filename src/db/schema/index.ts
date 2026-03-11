import {
  pgTable,
  text,
  timestamp,
  uuid,
  decimal,
  pgEnum,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";

export const merchantStatusEnum = pgEnum("merchant_status", [
  "pending",
  "active",
  "suspended",
  "closed",
]);

export const keyStatusEnum = pgEnum("key_status", ["active", "revoked"]);

export const walletTypeEnum = pgEnum("wallet_type", ["merchant", "customer"]);

export const walletStatusEnum = pgEnum("wallet_status", [
  "active",
  "frozen",
  "closed",
]);

export const ledgerDirectionEnum = pgEnum("ledger_direction", ["debit", "credit"]);

export const transactionTypeEnum = pgEnum("transaction_type", [
  "payin",
  "payout",
  "transfer",
]);

export const transactionStatusEnum = pgEnum("transaction_status", [
  "pending",
  "success",
  "failed",
]);

export const merchants = pgTable("merchants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  status: merchantStatusEnum("status").notNull().default("pending"),
  kycStatus: text("kyc_status").default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const merchantApiKeys = pgTable(
  "merchant_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    keyHash: text("key_hash").notNull().unique(),
    secretEnc: text("secret_enc").notNull(),
    environment: text("environment").notNull(), // "live" | "test"
    scopes: text("scopes").notNull().default(""), // comma-separated: payin:create,payout:create,balance:read
    status: keyStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("merchant_api_keys_merchant_id_idx").on(t.merchantId)]
);

export const wallets = pgTable(
  "wallets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    type: walletTypeEnum("type").notNull(),
    parentId: uuid("parent_id"), // for customer wallets, references merchant wallet
    balance: decimal("balance", { precision: 18, scale: 2 }).notNull().default("0"),
    currency: text("currency").notNull().default("BDT"),
    status: walletStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("wallets_merchant_id_idx").on(t.merchantId),
    index("wallets_parent_id_idx").on(t.parentId),
  ]
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    walletId: uuid("wallet_id")
      .notNull()
      .references(() => wallets.id, { onDelete: "cascade" }),
    amount: decimal("amount", { precision: 18, scale: 2 }).notNull(),
    direction: ledgerDirectionEnum("direction").notNull(),
    type: text("type").notNull(), // payin, payout, transfer, etc.
    referenceId: text("reference_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ledger_entries_wallet_id_idx").on(t.walletId),
    index("ledger_entries_reference_id_idx").on(t.referenceId),
  ]
);

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    type: transactionTypeEnum("type").notNull(),
    status: transactionStatusEnum("status").notNull().default("pending"),
    amount: decimal("amount", { precision: 18, scale: 2 }).notNull(),
    paidAmount: decimal("paid_amount", { precision: 18, scale: 2 }), // actual received (payin)
    currency: text("currency").notNull().default("BDT"),
    externalId: text("external_id"), // Payok platformOrderId
    metadata: text("metadata"), // JSON
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("transactions_merchant_id_idx").on(t.merchantId),
    index("transactions_external_id_idx").on(t.externalId),
  ]
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: text("key").notNull(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    responseSnapshot: text("response_snapshot").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.key, t.merchantId] }),
    index("idempotency_keys_expires_at_idx").on(t.expiresAt),
  ]
);
