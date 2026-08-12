# Dashboard depth APIs (Aug 2026)

Backend contracts for merchant portal + Transacty admin SPA. No new product rails — transparency for existing services.

## 1. Services / markets board

| | |
|--|--|
| Merchant | `GET /portal/me/services?environment=` · enriched `GET /portal/me/markets` |
| Admin | `GET /provider/merchants/:id/services` · enriched `GET /provider/merchants/:id/markets` |

Each market: `displayName`, `activationStatus`, `canRequest`, `ready`, `unlockReason`, `blockers[]`, `walletsProvisioned`. Wallets include `unlockReason` / `blockers`.

## 2. Customer + transaction dossiers

| | |
|--|--|
| Merchant | `GET /portal/me/customers/:id` → `txSummary` + `recentTransactions` (rail/fee) |
| Merchant | `GET /portal/me/customers/:id/transactions` → same enriched list shape |
| Admin | `GET /provider/merchants/:id/customers/:walletId/overview` → enriched txs + `txSummary` |
| Admin | `GET /provider/transactions/:id` → fees, `settlementCurrency`, `reconcileStatus`, `customer` |

## 3. Webhook delivery log

**Migration:** `npx tsx scripts/migrate-merchant-webhook-deliveries.ts`

| | |
|--|--|
| Merchant | `GET /portal/me/webhook/deliveries` (`lastError`) |
| Merchant | `POST /portal/me/webhook/deliveries/:id/replay` (step-up `webhook.write`) |
| Merchant | `POST /portal/me/webhook/test` (step-up) |
| Admin | `GET /provider/merchants/:id/webhook/deliveries` |

Outbound sends now write `merchant_webhook_deliveries`.

## 4. Audit CSV

| | |
|--|--|
| Merchant | `GET /portal/me/audit-log?format=csv` (step-up `audit.export`) |
| Admin | `GET /provider/merchants/:id/audit-log?format=csv` |

## 5. Admin KYC queue + reconcile + treasury (Aug 2026)

| | |
|--|--|
| KYC/KYB queue | `GET /provider/kyc-queue?reason=all\|global\|market&market=` |
| Reconcile console | `GET /provider/reconcile/queue?environment=&rail=` — includes `reconcileAction` / `inspectAction` hints |
| Dashboard KPIs | `marketKybPending`, `reconcileOpen` on `GET /provider/dashboard` |
| Treasury liquidity | `liquidity.pendingPayinByCurrency`, `pendingPayoutByCurrency`, `merchantBalancesByCurrency` on `GET /provider/treasury/overview` |

Existing detail/PATCH/POST settle routes are unchanged — queues are the glue for the admin SPA.

## 6. Per-rail money depth + India H2H portal (Aug 2026)

| | |
|--|--|
| Money overview | `GET /portal/me/money/overview?environment=` — per-rail counts, `canCreatePayin/Payout`, paths |
| Tx detail | `GET /portal/me/transactions/:id` — `provider`, `providerRefs`, `settlementCurrency`, `statusTimeline` |
| India H2H pay-in | `POST /portal/me/h2h/payin-instances`, `GET …/:transactionId`, `POST /portal/me/h2h/buyer-confirms-payment` |

Europe pay-in stays `/v1` only (`integrationHint` on overview).

## 7. Security / developers (Aug 2026)

| | |
|--|--|
| Overview | `GET /portal/me/security/overview` — MFA, session version note, API key counts, webhook, IP allowlist, recent security audit |
| Audit filter | `GET /portal/me/audit-log?actionPrefix=portal.api_key.` (exact `action=` still wins) |
| Step-up | Issue allowlist includes `audit.export` (needed for CSV) |

Existing: API keys CRUD, IP rules, webhook, MFA, revoke-sessions, step-up. No per-device session list (JWT + `sessionVersion` only).

## 8. Pricing vs merchant experience + adjustments (Aug 2026)

| | |
|--|--|
| Merchant fees | `GET /portal/me/fees?environment=` — active schedules + legacy BD fallback |
| Admin board | `GET /provider/merchants/:id/pricing/overview` — legacy, schedules, pending wallet adjustments, recent pricing audit, SPA links |
| Approvals | `GET /provider/approvals?merchantId=&status=&actionType=` — adds `merchantId`, `reviewPath` on items |

Existing write paths unchanged: fee-schedules POST (step-up), legacy pricing PATCH, wallet-adjustments (maker-checker when high risk), approve/reject.