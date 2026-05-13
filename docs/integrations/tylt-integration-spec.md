# Tylt Integration Spec (Working Draft)

Purpose: single source of truth for Tylt integration decisions, endpoints, signing, webhook handling, settlement semantics, and open questions. This document is intentionally implementation-ready and should be updated as new Tylt docs are shared.

Status: draft, based on shared docs in chat (Apr 29, 2026).

## 1) Scope and Services

Tylt integration currently spans two related capability groups:

- CrossRamp UPI Pay-in (INR -> USDT)
  - Hosted widget flow
  - H2H (host-to-host API) flow
- CPG (Crypto Payment Gateway)
  - Accept crypto-assets (pay-ins)
  - Transfer crypto-assets (payouts)

Core expectations:

- KYB-gated production access
- Demo environment for integration/testing
- Compliance and sanctions controls expected at merchant/account level

## 2) Environments and Credentials

Credential model:

- API key + Secret key generated per service
- Demo and production credentials are environment-specific
- Regenerating keys may invalidate prior keys
- Secret only shown at creation time

Storage/security requirements:

- Keep keys server-side only
- Never expose secret in frontend or logs
- Use secrets manager / encrypted env storage
- Rotate immediately on compromise

## 3) Authentication and Request Signing

Headers required on Tylt API calls:

- `X-TLP-APIKEY`
- `X-TLP-SIGNATURE`

Signing algorithm:

- HMAC-SHA256 using API Secret key

Canonical signing behavior from docs/examples:

- POST: sign JSON body string
- GET: docs show mixed examples, but most examples sign `JSON.stringify(params)` while query string is sent in URL

Integration policy (to keep deterministic and testable):

- For POST: sign exact raw string sent in request body
- For GET with params: sign compact JSON serialization of params object used to build query
- For GET without params: sign compact JSON of empty object (`{}`)

Important:

- Signature payload must match sent payload semantics exactly
- Any formatting mismatch can cause signature mismatch

### Circuit breaker (Transacty outbound)

- Separate rail key **`tylt`** from Payok (`payok`); state does not cross rails.
- Implement all `https://api.tylt.money/` calls via **`tyltFetch`** (`services/integrations/tylt/http.ts`) so failures open only the Tylt circuit.
- Optional env: `PROVIDER_CIRCUIT_TYLT_FAILURE_THRESHOLD`, `PROVIDER_CIRCUIT_TYLT_COOLDOWN_MS` (fallback to global `PROVIDER_CIRCUIT_FAILURE_THRESHOLD` / `PROVIDER_CIRCUIT_COOLDOWN_MS`).

## 4) CrossRamp UPI Pay-in (INR -> USDT)

### 4.1 Hosted Widget Flow (non-H2H)

Create instance:

- `POST /p2pRampsMerchant/createInstance`
- Returns URL + `instanceId`
- Key fields include:
  - `merchantOrderId`
  - `callBackUrl`
  - `redirectUrl`
  - `amount` + `currencySymbol` (`USDT` or `INR`)
  - `isUTRNeeded` (must be `1`)
  - `isKYCNeeded` (`0` bypass requires admin approval)

Status tracking:

- Webhook on callback URL
- Optional pull by:
  - `GET /p2pRampsMerchant/getInstanceDetails?merchantOrderId=...`
  - `GET /p2pRampsMerchant/getInstanceDetails?instanceId=...`
  - `GET /transactions/merchant/getPayinTransactionInformation?orderId=...`

### 4.2 H2H Flow

Create instance:

- `POST /h2h/in/upi/createPayinInstance`

Buyer confirm:

- `POST /h2h/in/upi/buyerConfirmsPayment`
- Uses `instanceId` (+ `utr` when UTR required)

Auxiliary endpoints:

- `GET /h2h/in/upi/getPaymentMethods_p2pOnRamp`
- `GET /h2h/in/upi/getCryptoCurrencyListForPrime`

Webhook:

- HMAC verification with `X-TLP-SIGNATURE`
- Must respond HTTP 200 with body `"ok"` (per docs)

## 5) CPG Accept Crypto-Assets (Pay-in)

Create pay-in request:

- `POST /transactions/merchant/createPayinRequest`

Notable fields:

- `merchantOrderId` (recommended unique)
- `baseAmount`
- `baseCurrency` (fiat or crypto)
- `settledCurrency` (crypto)
- `networkSymbol`
- `callBackUrl`
- `settleUnderpayment` (behavior control)
- `payeeDetails` (travel-rule object; mandatory in docs)

Read APIs:

- `GET /transactions/merchant/getPayinTransactionHistory?rows={rows}&page={page}`
- `GET /transactions/merchant/getPayinTransactionInformation?orderId={orderId}`

Status model highlighted:

- `Pending`
- `Completed`
- `Under Payment`
- `Over Payment`
- `Expired`

Settlement fields to track:

- `settledAmountRequested`
- `settledAmountReceived`
- `settledAmountCredited`
- `baseAmountReceived` (spelling in docs is inconsistent in places)
- `isFinal`
- `isCredited`

## 6) CPG Transfer Crypto-Assets (Payout)

Create payout:

- `POST /transactions/merchant/createPayoutRequest`

Read APIs:

- `GET /transactions/merchant/getPayoutTransactionHistory?rows={rows}&page={page}`
- `GET /transactions/merchant/getPayoutTransactionInformation?orderId={orderId}`

Key payout tracking fields:

- `settledAmountRequested`
- `settledAmountDebited`
- `settledAmountSent`
- `isFinal`
- `isDebited`
- `insufficientBalance`

## 7) Internal Transfer (Ledger Movement)

Purpose:

- Move balances between merchant-owned Tylt wallets (off-chain, no blockchain fee)

Endpoints:

- `POST /transactions/merchant/transferMerchantBalance`
- `GET /transactions/merchant/getMerchantDetails` (wallet discovery for transfer source/destination UUIDs)

Transfer request fields:

- `fromUUID`
- `toUUID`
- `settledAmount`
- `settledCurrency`
- `comments` (optional)

Operational guidance:

- Treat internal transfer as balance reallocation only (not customer settlement event)
- Persist returned transfer order/transaction ID for reconciliation
- Require explicit allowlist or role check for source/destination wallet pairs

## 8) Supporting Discovery / Config APIs

Currency and network discovery:

- `GET /transactions/merchant/getSupportedCryptoCurrenciesList`
- `GET /transactions/merchant/getSupportedFiatCurrenciesList`
- `GET /transactions/merchant/getSupportedCryptoNetworksList`
- `GET /transactions/merchant/getSupportedBaseCurrenciesList`

Balance and wallet introspection:

- `GET /transactions/merchant/getAccountBalance`
- `GET /transactions/merchant/getMerchantDetails`

Notes:

- Prefer these APIs as runtime validation sources for requested currency/network combinations
- Cache with TTL for performance, but allow manual refresh in admin/ops flows

### 8.1 Transacty merchant API (`/v1/*`)

Implemented merchant-facing proxies and create endpoints are documented in **[tylt-merchant-api.md](./tylt-merchant-api.md)** (scopes, idempotency, error conventions, Zod schema pointers). **Public paths** are processor-neutral (e.g. `/v1/cpg/...`); **`/v1/tylt/...`** remains as a **legacy alias** in `app.ts`.

## 9) Webhook Lifecycle Mapping (Current)

UPI webhook event IDs seen:

- `0` created
- `1` trade initiated
- `2` waiting for buyer payment
- `3` buyer confirms, seller verifies
- `4` completed
- `5` disputed
- `6` completed by system
- `9` expired

Backend finality guidance:

- Treat `4` and `6` as successful final states (subject to signature validation and field checks)
- Treat `5` and `9` as terminal non-success states
- `0-3` are non-final progress states

### 9.1 UPI CrossRamp event IDs

These are integration defaults to keep money movement safe:

- Never credit internal user balance before final state + valid signature
- Require idempotency on webhook/event ingestion
- Persist raw webhook payload + signature verification result for audit
- Reconcile pull APIs against webhook state for dispute/ops flows
- For under/over payment, route to explicit business policy handlers (do not auto-assume equivalence)

### 9.2 CPG pay-in / payout webhook states

Documented CPG status values:

- Pay-in: `Pending`, `Completed`, `Under Payment`, `Over Payment`, `Expired`
- Payout: `Pending`, `Completed` (and potentially failure states in runtime responses)

Webhook envelope examples:

- `type: "pay-in"` includes `baseAmountReceived`, `settledAmountReceived`, `settledAmountCredited`, `isFinal`, `isCredited`
- `type: "pay-out"` includes `settledAmountDebited`, `settledAmountSent`, `isFinal`, `isDebited`

Ack semantics:

- Respond HTTP 200 and body `"ok"`
- Docs indicate no automatic retry on missed ack; manual resend from dashboard

## 10) Business Handling Rules (Proposed)

These are integration defaults to keep money movement safe:

- Never credit internal user balance before final state + valid signature
- Require idempotency on webhook/event ingestion
- Persist raw webhook payload + signature verification result for audit
- Reconcile pull APIs against webhook state for dispute/ops flows
- For under/over payment, route to explicit business policy handlers (do not auto-assume equivalence)

Suggested crediting rule:

- Credit amount based on explicit product policy:
  - crypto-ledger products -> use `settledAmountReceived` / `settledAmountCredited`
  - fiat-denominated products -> use `baseAmountReceived` equivalent

## 11) Compliance and Risk Notes

- KYC bypass (`isKYCNeeded=0`) should be disabled by default and gated by config/approval
- Keep sanctions/compliance failures fail-safe (reject/hold, do not auto-complete)
- Keep secrets/PII out of logs

## 12) Known Documentation Inconsistencies

Track ambiguities here and validate before production rollout:

- Some examples sign GET using query string; others sign JSON params object
- Field naming inconsistency:
  - `baseAmountRecieved` vs `baseAmountReceived`
  - `isReceiprocal` typo in custom rate examples
- Some snippet JSON appears malformed (duplicate keys, missing commas, misspelled values)
- Payout history page heading/endpoint text has minor copy issues in parts
- `getMerchantDetails` docs mention `fromWalletId`/`toWalletId` in description while request body uses `fromUUID`/`toUUID`
- Some GET signing examples use empty string/query string, others use `'{}'`

Integration action:

- Do not rely on snippet syntax verbatim; rely on endpoint behavior + consistent client conventions.

## 13) Open Questions (Remaining Before Production Hardening)

- Exact retry policy and delivery guarantees for callbacks
- Full status transition matrix for CPG pay-in/payout
- Required/optional travel-rule fields by jurisdiction/service
- Minimum confirmations per network and confirmation status semantics
- Exact behavior of `settleUnderpayment=0` at expiry across all flows
- Error code catalog and retry/backoff recommendations
- Rate-limit expectations and timeout guidance
- Internal transfer failure/error state catalog and reversibility semantics

## 14) Integration File Plan (No Code Yet)

When implementation starts, keep Tylt isolated in dedicated provider files.

Proposed boundaries:

- Tylt HTTP/signature client (shared)
- CrossRamp service adapter (UPI widget + H2H)
- CPG pay-in adapter
- CPG payout adapter
- Webhook verifier/parser/mapper
- Status-to-domain mapping utilities

This keeps Tylt-specific logic separate from existing providers and simplifies audits/testing.

---

Appendix: source docs were shared by user directly in chat. Add URLs here as canonical references once final set is complete.
