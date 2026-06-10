# Provider Dashboard API Update (Frontend Handoff)

This file is the single source of truth for the latest provider/super-admin dashboard backend updates.

## Base

- Auth: provider JWT (`Authorization: Bearer <token>`)
- Base path: `/provider/*`

---

## New Endpoints Added

## 1) Global Dashboard

### `GET /provider/dashboard`

Returns global KPI cards, review-required issues, and role-based action capability hints.

Response (shape):

```json
{
  "kpis": {
    "merchants": {
      "total": 0,
      "active": 0,
      "pending": 0,
      "suspended": 0
    },
    "kycPending": 0,
    "approvalsPending": 0,
    "transactions": {
      "pending": 0,
      "failed": 0,
      "reviewRequired": 0
    }
  },
  "recentIssues": [
    {
      "transactionId": "uuid",
      "merchantId": "uuid",
      "merchantName": "string",
      "type": "review_required",
      "status": "pending",
      "createdAt": "ISO_DATE"
    }
  ],
  "myActions": {
    "merchant": [
      "status_change",
      "kyc_review",
      "pricing_update",
      "wallet_adjustment",
      "tx_reconcile",
      "tx_status_change"
    ],
    "customer": [
      "status_change",
      "view_wallet_and_timeline"
    ]
  }
}
```

---

## 2) Merchant 360 Drill-Down

### `GET /provider/merchants/:merchantId/overview?txLimit=20&customerLimit=20`

Returns all key merchant-level sections for one-screen drill view.

Response (shape):

```json
{
  "merchant": {
    "id": "uuid",
    "name": "string",
    "status": "pending|active|suspended|closed",
    "kycStatus": "pending|verified|rejected",
    "createdAt": "ISO_DATE"
  },
  "wallets": [
    {
      "id": "uuid",
      "environment": "test|live",
      "currency": "string",
      "balance": "decimal-string",
      "status": "active|frozen|pending|closed"
    }
  ],
  "kyc": {
    "profile": {
      "id": "uuid",
      "legalName": "string",
      "businessType": "string",
      "status": "draft|submitted|verified|rejected",
      "rejectionReason": "string|null"
    },
    "personsCount": 0,
    "documentsCount": 0
  },
  "customers": {
    "total": 0,
    "active": 0,
    "frozen": 0,
    "pending": 0,
    "closed": 0,
    "recent": [
      {
        "walletId": "uuid",
        "label": "string|null",
        "balance": "decimal-string",
        "status": "string",
        "createdAt": "ISO_DATE"
      }
    ]
  },
  "transactions": {
    "total": 0,
    "pending": 0,
    "success": 0,
    "failed": 0,
    "reviewRequired": 0,
    "recent": [
      {
        "id": "uuid",
        "type": "payin|payout|transfer|refund",
        "status": "pending|success|failed",
        "amount": "decimal-string",
        "paidAmount": "decimal-string|null",
        "currency": "string",
        "createdAt": "ISO_DATE"
      }
    ]
  },
  "approvals": {
    "pendingCount": 0,
    "recent": [
      {
        "id": "uuid",
        "actionType": "wallet_adjustment|transaction_status_change",
        "status": "pending|approved|rejected|executed|cancelled",
        "riskLevel": "normal|high",
        "createdAt": "ISO_DATE"
      }
    ]
  },
  "auditTrail": [
    {
      "id": "uuid",
      "action": "string",
      "resource": "string|null",
      "createdAt": "ISO_DATE"
    }
  ]
}
```

---

## 3) Customer 360 Drill-Down (within merchant)

### `GET /provider/merchants/:merchantId/customers/:walletId/overview`

Returns deep wallet/customer context and role-based available actions.

Response (shape):

```json
{
  "customer": {
    "walletId": "uuid",
    "merchantId": "uuid",
    "merchantName": "string",
    "label": "string|null",
    "environment": "test|live",
    "currency": "string",
    "balance": "decimal-string",
    "status": "active|frozen|pending|closed",
    "createdAt": "ISO_DATE"
  },
  "ledger": [
    {
      "id": "uuid",
      "direction": "credit|debit",
      "type": "string",
      "amount": "decimal-string",
      "referenceId": "string|null",
      "createdAt": "ISO_DATE"
    }
  ],
  "transactions": [
    {
      "id": "uuid",
      "type": "payin|payout|transfer|refund",
      "status": "pending|success|failed",
      "amount": "decimal-string",
      "paidAmount": "decimal-string|null",
      "currency": "string",
      "createdAt": "ISO_DATE"
    }
  ],
  "actions": [
    "wallet_adjustment",
    "change_status",
    "review_transactions",
    "request_reconcile"
  ]
}
```

---

## New Customer Action Endpoint Added

## 4) Customer Wallet Adjustment

### `POST /provider/customers/:walletId/wallet-adjustments`

Request:

```json
{
  "direction": "credit|debit",
  "amount": "100.00",
  "reason": "ops correction",
  "referenceId": "TICKET-123"
}
```

Responses:

- `200` executed immediately
- `202` queued for maker-checker approval when high-risk

`200` shape:

```json
{
  "walletId": "uuid",
  "merchantId": "uuid",
  "direction": "credit|debit",
  "amount": "100.00",
  "previousBalance": "1000.00",
  "currentBalance": "1100.00"
}
```

`202` shape:

```json
{
  "requestId": "uuid",
  "status": "pending",
  "requiresApproval": true
}
```

---

## Existing Action Endpoints Frontend Should Continue Using

Merchant actions:

- `PATCH /provider/merchants/:merchantId/status`
- `PATCH /provider/merchants/:merchantId/kyc`
- `GET /provider/merchants/:merchantId/pricing`
- `PATCH /provider/merchants/:merchantId/pricing`
- `POST /provider/merchants/:merchantId/wallet-adjustments`

Customer actions:

- `PATCH /provider/customers/:walletId/status`
- `POST /provider/customers/:walletId/wallet-adjustments` (new)

Transaction + approval actions:

- `GET /provider/transactions`
- `PATCH /provider/transactions/:transactionId/status`
- `GET /provider/transactions/:transactionId/reconcile`
- `GET /provider/approvals`
- `POST /provider/approvals/:requestId/approve`
- `POST /provider/approvals/:requestId/reject`

---

## Notes for Frontend Integration

- Render action buttons from returned `myActions` and `actions` arrays to keep UI permission-aware.
- Expect some mutations to return `202` (approval queued) instead of immediate `200`.
- Keep drill flow:
  - dashboard -> merchant overview -> customer overview -> action modal -> refresh section data.
- All money amounts are strings; do not parse as float in UI state logic unless necessary for display formatting.

---

## Provider admin expansion (June 2026)

Merchant detail panels and transaction monitor upgrades for the super-admin SPA.

### KYC review (read-only + document download)

| Method | Path | Permission |
|--------|------|------------|
| GET | `/provider/merchants/:merchantId/kyc/business` | `merchant.read` |
| GET | `/provider/merchants/:merchantId/kyc/persons` | `merchant.read` |
| GET | `/provider/merchants/:merchantId/kyc/documents` | `merchant.read` |
| GET | `/provider/merchants/:merchantId/kyc/documents/:documentId/download-url` | `merchant.kyc.write` |

`download-url` returns `{ downloadUrl, expiresIn }` (signed Supabase URL, 1h). Requires `SUPABASE_*` env on API.

### Merchant ops visibility

| Method | Path | Permission |
|--------|------|------------|
| GET | `/provider/merchants/:merchantId/audit-log?limit&offset&action` | `merchant.read` |
| GET | `/provider/merchants/:merchantId/webhook` | `merchant.read` |
| GET | `/provider/merchants/:merchantId/users` | `merchant.read` |
| GET | `/provider/merchants/:merchantId/api-keys` | `merchant.read` |
| PATCH | `/provider/merchants/:merchantId/api-keys/:keyId` `{ status: "revoked", reason? }` | `merchant.status.write` |

Webhook response: `{ webhookUrl, webhookConfigured }` (secret never exposed).

Markets (unchanged): `GET/PATCH /provider/merchants/:merchantId/markets` — see `PORTAL_MARKETS_WALLETS_FRONTEND.md`.

### Transactions

**List** `GET /provider/transactions` — new query params:

- `environment` — `test` \| `live`
- `reviewRequired` — `true` filters pending txs flagged in metadata

Each item now includes: `currency`, `environment`, `provider`, `reviewRequired`, `rail`, `railLabel`.

**Detail** `GET /provider/transactions/:transactionId` — full row + parsed `metadata` object + rail fields.

### Approvals

**List** `GET /provider/approvals` — each item now includes `reason`, `rejectedReason`, `payload` (parsed JSON).

**Detail** `GET /provider/approvals/:requestId` — full approval row including `payload`, timestamps.

### Audit persistence

Provider mutations (status, KYC, pricing, wallet adjust, tx status, reconcile) now write to `merchant_audit_log` when `merchantId` is known. Use `GET …/audit-log` for paginated history (replaces relying only on the 20-row snippet in overview).
