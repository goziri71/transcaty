import {
  pgTable,
  text,
  timestamp,
  uuid,
  decimal,
  pgEnum,
  index,
  primaryKey,
  boolean,
  unique,
  json,
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
  "pending",
  "closed",
]);

export const ledgerDirectionEnum = pgEnum("ledger_direction", ["debit", "credit"]);

export const transactionTypeEnum = pgEnum("transaction_type", [
  "payin",
  "payout",
  "transfer",
  "refund",
]);

export const transactionStatusEnum = pgEnum("transaction_status", [
  "pending",
  "success",
  "failed",
]);

export const payokEnvironmentEnum = pgEnum("payok_environment", ["test", "live"]);

export const kycProfileStatusEnum = pgEnum("kyc_profile_status", [
  "draft",
  "submitted",
  "verified",
  "rejected",
]);

export const kycDocumentStatusEnum = pgEnum("kyc_document_status", [
  "pending",
  "verified",
  "rejected",
]);

export const kycPersonRoleEnum = pgEnum("kyc_person_role", [
  "director",
  "ubo",
  "authorized_signatory",
]);

export const merchantUserRoleEnum = pgEnum("merchant_user_role", [
  "admin",
  "finance",
  "viewer",
]);

export const providerUserRoleEnum = pgEnum("provider_user_role", [
  "super_admin",
  "ops",
  "risk",
  "finance",
  "support",
]);

export const providerActionTypeEnum = pgEnum("provider_action_type", [
  "wallet_adjustment",
  "transaction_status_change",
]);

export const providerActionStatusEnum = pgEnum("provider_action_status", [
  "pending",
  "approved",
  "rejected",
  "executed",
  "cancelled",
]);

export const passwordResetRealmEnum = pgEnum("password_reset_realm", ["portal", "provider"]);

export const kycStatusEnum = pgEnum("kyc_status", ["pending", "verified", "rejected"]);

export const billingModeEnum = pgEnum("billing_mode", [
  "percentage_only",
  "monthly_only",
  "both",
]);

export const merchants = pgTable("merchants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  status: merchantStatusEnum("status").notNull().default("pending"),
  kycStatus: text("kyc_status").default("pending"),
  webhookUrl: text("webhook_url"),
  webhookSecretEnc: text("webhook_secret_enc"),
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
    environment: payokEnvironmentEnum("environment").notNull().default("test"),
    parentId: uuid("parent_id"), // for customer wallets, references merchant wallet
    label: text("label"), // customer display name (e.g. "John Doe", "user@example.com")
    balance: decimal("balance", { precision: 18, scale: 2 }).notNull().default("0"),
    currency: text("currency").notNull().default("BDT"),
    status: walletStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("wallets_merchant_id_idx").on(t.merchantId),
    index("wallets_merchant_env_type_idx").on(t.merchantId, t.environment, t.type),
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
    environment: payokEnvironmentEnum("environment").notNull().default("test"),
    amount: decimal("amount", { precision: 18, scale: 2 }).notNull(),
    direction: ledgerDirectionEnum("direction").notNull(),
    type: text("type").notNull(), // payin, payout, transfer, etc.
    referenceId: text("reference_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ledger_entries_wallet_id_idx").on(t.walletId),
    index("ledger_entries_wallet_env_idx").on(t.walletId, t.environment),
    index("ledger_entries_reference_id_idx").on(t.referenceId),
  ]
);

export const merchantPricing = pgTable(
  "merchant_pricing",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" })
      .unique(),
    billingMode: billingModeEnum("billing_mode").notNull().default("percentage_only"),
    feePercentagePayin: decimal("fee_percentage_payin", { precision: 5, scale: 4 }).default("0"),
    feePercentagePayout: decimal("fee_percentage_payout", { precision: 5, scale: 4 }).default("0"),
    feeMinPayin: decimal("fee_min_payin", { precision: 18, scale: 2 }).default("0"),
    feeMaxPayin: decimal("fee_max_payin", { precision: 18, scale: 2 }),
    feeMinPayout: decimal("fee_min_payout", { precision: 18, scale: 2 }).default("0"),
    feeMaxPayout: decimal("fee_max_payout", { precision: 18, scale: 2 }),
    monthlyAmount: decimal("monthly_amount", { precision: 18, scale: 2 }).default("0"),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("merchant_pricing_merchant_id_idx").on(t.merchantId)]
);

export const monthlyBillingRecords = pgTable(
  "monthly_billing_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    billingMonth: text("billing_month").notNull(),
    amount: decimal("amount", { precision: 18, scale: 2 }).notNull(),
    ledgerEntryId: uuid("ledger_entry_id").references(() => ledgerEntries.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("monthly_billing_records_merchant_month_idx").on(t.merchantId, t.billingMonth),
    unique().on(t.merchantId, t.billingMonth),
  ]
);

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    walletId: uuid("wallet_id").references(() => wallets.id, { onDelete: "set null" }), // customer wallet for transfer/refund
    environment: payokEnvironmentEnum("environment").notNull().default("test"),
    type: transactionTypeEnum("type").notNull(),
    status: transactionStatusEnum("status").notNull().default("pending"),
    amount: decimal("amount", { precision: 18, scale: 2 }).notNull(),
    paidAmount: decimal("paid_amount", { precision: 18, scale: 2 }), // actual received (payin)
    currency: text("currency").notNull().default("BDT"),
    externalId: text("external_id"), // Payok platformOrderId
    metadata: text("metadata"), // JSON: { refundOfTransactionId?, reason?, customerWalletId?, ... }
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("transactions_merchant_id_idx").on(t.merchantId),
    index("transactions_merchant_env_idx").on(t.merchantId, t.environment),
    index("transactions_wallet_id_idx").on(t.walletId),
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

export const merchantBusinessProfiles = pgTable(
  "merchant_business_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" })
      .unique(),
    legalName: text("legal_name").notNull(),
    tradingName: text("trading_name"),
    businessType: text("business_type").notNull(), // sole_proprietorship, partnership, private_limited, public_limited
    registrationNumber: text("registration_number"),
    incorporationDate: timestamp("incorporation_date", { withTimezone: true }),
    industry: text("industry"),
    registeredAddress: text("registered_address").notNull(),
    operatingAddress: text("operating_address"),
    taxId: text("tax_id"),
    contactPhone: text("contact_phone").notNull(),
    contactEmail: text("contact_email").notNull(),
    status: kycProfileStatusEnum("status").notNull().default("draft"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("merchant_business_profiles_merchant_id_idx").on(t.merchantId), index("merchant_business_profiles_status_idx").on(t.status)]
);

export const merchantPersons = pgTable(
  "merchant_persons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    role: kycPersonRoleEnum("role").notNull(),
    fullName: text("full_name").notNull(),
    nationality: text("nationality").notNull(),
    dateOfBirth: timestamp("date_of_birth", { withTimezone: true }),
    idType: text("id_type").notNull(), // nid, passport
    idNumber: text("id_number").notNull(),
    address: text("address").notNull(),
    ownershipPercentage: decimal("ownership_percentage", { precision: 5, scale: 2 }),
    status: kycDocumentStatusEnum("status").notNull().default("pending"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("merchant_persons_merchant_id_idx").on(t.merchantId),
    index("merchant_persons_merchant_id_role_idx").on(t.merchantId, t.role),
    index("merchant_persons_status_idx").on(t.status),
  ]
);

export const merchantKycDocuments = pgTable(
  "merchant_kyc_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    merchantPersonId: uuid("merchant_person_id").references(() => merchantPersons.id, { onDelete: "set null" }),
    documentType: text("document_type").notNull(), // registration_certificate, trade_license, tax_certificate, nid, passport, etc.
    fileReference: text("file_reference").notNull(),
    documentNumber: text("document_number"),
    status: kycDocumentStatusEnum("status").notNull().default("pending"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("merchant_kyc_documents_merchant_id_idx").on(t.merchantId),
    index("merchant_kyc_documents_merchant_id_status_idx").on(t.merchantId, t.status),
    index("merchant_kyc_documents_merchant_person_id_idx").on(t.merchantPersonId),
  ]
);

export const merchantUsers = pgTable(
  "merchant_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    passwordHash: text("password_hash"),
    role: merchantUserRoleEnum("role").notNull().default("viewer"),
    merchantPersonId: uuid("merchant_person_id").references(() => merchantPersons.id, { onDelete: "set null" }),
    status: text("status").notNull().default("active"), // active, suspended
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    mfaPending: boolean("mfa_pending").notNull().default(false),
    mfaSecretEnc: text("mfa_secret_enc"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("merchant_users_merchant_id_idx").on(t.merchantId),
    index("merchant_users_email_idx").on(t.email),
    index("merchant_users_merchant_email_idx").on(t.merchantId, t.email),
  ]
);

/** Per-merchant audit trail for the portal (money movements, auth, API keys, etc.). */
export const merchantAuditLog = pgTable(
  "merchant_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    merchantUserId: uuid("merchant_user_id").references(() => merchantUsers.id, {
      onDelete: "set null",
    }),
    actorEmail: text("actor_email"),
    action: text("action").notNull(),
    resource: text("resource"),
    meta: json("meta").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("merchant_audit_log_merchant_created_idx").on(t.merchantId, t.createdAt),
    index("merchant_audit_log_action_idx").on(t.merchantId, t.action),
  ]
);

export const providerUsers = pgTable(
  "provider_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    fullName: text("full_name"),
    passwordHash: text("password_hash").notNull(),
    role: providerUserRoleEnum("role").notNull().default("ops"),
    status: text("status").notNull().default("active"), // active, suspended
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    mfaPending: boolean("mfa_pending").notNull().default(false),
    mfaSecretEnc: text("mfa_secret_enc"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("provider_users_email_idx").on(t.email),
    index("provider_users_role_idx").on(t.role),
    index("provider_users_status_idx").on(t.status),
  ]
);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    realm: passwordResetRealmEnum("realm").notNull(),
    userId: uuid("user_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("password_reset_tokens_user_realm_idx").on(t.realm, t.userId),
    index("password_reset_tokens_expires_at_idx").on(t.expiresAt),
  ]
);

export const providerActionRequests = pgTable(
  "provider_action_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actionType: providerActionTypeEnum("action_type").notNull(),
    status: providerActionStatusEnum("status").notNull().default("pending"),
    requestedBy: uuid("requested_by").references(() => providerUsers.id, { onDelete: "set null" }),
    approvedBy: uuid("approved_by").references(() => providerUsers.id, { onDelete: "set null" }),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    payload: text("payload").notNull(), // JSON object for deferred execution
    reason: text("reason"),
    ticketId: text("ticket_id"),
    riskLevel: text("risk_level").notNull().default("normal"),
    rejectedReason: text("rejected_reason"),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("provider_action_requests_status_idx").on(t.status),
    index("provider_action_requests_action_type_idx").on(t.actionType),
    index("provider_action_requests_requested_by_idx").on(t.requestedBy),
    index("provider_action_requests_approved_by_idx").on(t.approvedBy),
    index("provider_action_requests_created_at_idx").on(t.createdAt),
  ]
);
