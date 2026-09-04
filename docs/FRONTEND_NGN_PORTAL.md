# NGN — merchant portal frontend handoff

Portal JWT surfaces for **Nigeria NGN**: one **permanent virtual account** per merchant (reusable bank details, any inbound amount) + **NGN bank payout**. Settles to merchant **NGN** wallet. Live-only (no Tekko sandbox). Do **not** show Tekko branding on happy-path UI.

Related: [`MERCHANT_NGN_INTEGRATION.md`](./MERCHANT_NGN_INTEGRATION.md) · Provider: [`FRONTEND_NGN_PROVIDER.md`](./FRONTEND_NGN_PROVIDER.md) · Markets: [`PORTAL_MARKETS_WALLETS_FRONTEND.md`](./PORTAL_MARKETS_WALLETS_FRONTEND.md)

## Markets & wallets

| Action | Endpoint |
|--------|----------|
| List markets | `GET /portal/me/markets` — includes `market: "nigeria"` |
| Request access | `POST /portal/me/markets/nigeria/request` |
| Services board | `GET /portal/me/services?environment=live` |
| Wallets / balance | `GET /portal/me/wallets` / `GET /portal/me/balance` — after approve, an **NGN** card (`currency: "NGN"`, `region: "nigeria"`). Use **`environment=live`**. Test has no NGN pocket (`live_only`). |

If `entitlementStatus` is `approved` but the test catalog shows `walletActivated: false` + `live_only`, the market is approved — switch the dashboard to **live**. Do not treat that as “not approved.”

Copy: “Payers transfer any amount to your permanent NGN account. Credits land in your NGN wallet. Payouts send NGN to Nigerian bank accounts.”

## Virtual account (collect)

There is **no** amount / expiry / one-time collection create. Merchants provision once, then share bank details forever.

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/portal/me/ngn/virtual-account` | Current status + details (or `bvn_required`). Money role only — **no** `Idempotency-Key` |
| `POST` | `/portal/me/ngn/virtual-account` | Submit **BVN Basic** + provision VA; money role + MFA step-up; **`Idempotency-Key` required** |

Query/body: `environment` defaults to `live`. `environment: "test"` → `503` `payment_unavailable`.

**POST body:**

```json
{
  "environment": "live",
  "bvn": "22123456789",
  "firstName": "Ada",
  "lastName": "Okafor",
  "phoneNumber": "+2348012345678",
  "dateOfBirth": "1990-01-15",
  "customerEmail": "ada@example.com"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `bvn` | yes | 11 digits. Encrypted at rest in Transacty compliance store; **never** redisplay in UI after submit |
| `firstName` / `lastName` | yes | Must match BVN Basic name check |
| `phoneNumber` | no | |
| `dateOfBirth` | no | `YYYY-MM-DD` |
| `customerEmail` | no | |
| `faceImage` | — | **Do not send** (Basic path only) |

**Response (200):**

```json
{
  "status": "active",
  "bvnStatus": "verified",
  "accountNumber": "0123456789",
  "bankName": "Wema Bank",
  "accountName": "ADA OKAFOR",
  "currency": "NGN",
  "ready": true,
  "environment": "live"
}
```

| `status` / UI | Meaning |
|---------------|---------|
| `bvn_required` + `ready: false` | Show BVN form |
| `pending` | BVN or VA still processing — poll GET |
| `active` / `ready: true` | Show **accountNumber**, **bankName**, **accountName** (copy / QR) |
| `bvnStatus: failed` | Ask merchant to re-check name / BVN and POST again |

Inbound credits create pay-ins automatically (`provider: tekko-ngn-va`). Merchants do **not** create a pay-in intent for each transfer.

## Payout

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/portal/me/ngn/banks?search=` | Bank list for picker |
| `POST` | `/portal/me/ngn/verify-account` | Name enquiry before send |
| `POST` | `/portal/me/ngn/payouts` | Debit NGN wallet; `Idempotency-Key` required |
| `GET` | `/portal/me/ngn/payouts/:transactionId` | Poll status |

**Verify body:**

```json
{
  "environment": "live",
  "accountNumber": "0123456789",
  "bankCode": "035"
}
```

**Payout body:**

```json
{
  "environment": "live",
  "amount": "5000.00",
  "merchantReference": "wd-1001",
  "description": "Supplier payment",
  "beneficiary": {
    "accountNumber": "0123456789",
    "bankCode": "035",
    "accountName": "ADA OKAFOR",
    "bankName": "Wema Bank"
  }
}
```

**Limits:** NGN payout **100 – 5,000,000** per request. Create response is `201` with fee breakdown fields when available; recipient shown as masked account only.

**Payout errors (400):** responses include optional `code` — use it for routing, not only `message`:

| `code` | Action |
|--------|--------|
| `ngn_bvn_required` | Redirect to Nigeria **Virtual account / BVN** (not global KYC). Merchant must `POST /portal/me/ngn/virtual-account` with BVN Basic fields until `bvnStatus === "verified"`. |
| `insufficient_balance` | Show NGN wallet balance |
| `payout_failed` | Generic retry / support |

Example:

```json
{
  "error": "Bad Request",
  "code": "ngn_bvn_required",
  "message": "Complete BVN verification before NGN payouts. Submit your BVN under Nigeria virtual account settings."
}
```

Until a deploy that includes the schema fix, the same case may return **only** `error` + `message` (no `code`). Fallback: match `message` containing `"BVN verification"` or route users from VA `GET` when `bvnStatus !== "verified"`.

Payouts can fail closed if Tekko master withdraw has insufficient liquidity even when the merchant NGN wallet has balance — show a generic failure and ops note (no Tekko branding).

## Transaction history

`GET /portal/me/transactions?rail=nigeria` — includes VA pay-ins (`tekko-ngn-va`), legacy collect (`tekko-ngn-collect`), and payouts (`tekko-ngn-payout`).

| Provider | `rail` | `railLabel` |
|----------|--------|-------------|
| `tekko-ngn-va` | `nigeria` | Nigeria NGN virtual account |
| `tekko-ngn-payout` | `nigeria` | Nigeria NGN payout |
| `tekko-ngn-collect` | `nigeria` | Nigeria NGN collect (legacy) |

## Checklist

- [ ] Markets card for `nigeria` + request CTA
- [ ] Live-only: hide NGN money UI in test (or show “switch to live”)
- [ ] VA page: GET status → BVN form or permanent bank details (no amount/expiry)
- [ ] Never persist or log BVN in the SPA after submit
- [ ] Payout wizard: banks → verify → send → poll
- [ ] Tx list chip `rail=nigeria`
- [ ] NGN wallet balance reflects credits and payouts
