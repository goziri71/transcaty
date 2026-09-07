# Tekko NGN — ops entitlement checklist

Before enabling Transacty NGN in production, confirm the **Tekko partner account** has the NGN product flags. Missing flags return HTTP `403` with code `SERVICE_NOT_ENTITLED`.

## Required

| Tekko flag | Needed for |
|------------|------------|
| `ngn_collections` | Permanent per-merchant customer NGN VA (`…/customers/:id/ng/virtual-account*`) |
| `ngn_payouts` | `POST /master-wallet/ng/withdraw` and related bank payout |

Also: **merchant BVN / KYB on Tekko** (partner go-live checklist in the Tekko dashboard) before NGN withdraw works. Customer BVN on Transacty VA is **not** the same gate — if Tekko returns `Complete KYB → BVN in the dashboard`, ops must finish partner KYB on Tekko; re-submitting portal BVN will not unlock payouts.

## Product note

Transacty merchant collect is **permanent customer VA** (BVN Basic, no faceImage) — not temporary exact-amount collections.

Customer VA credits land on Tekko **customer** NGN sub-ledger; payouts debit **master**. Confirm with Tekko how deposits become available for `ng/withdraw` before go-live of VA + payout together.

## How to verify

Reuse the same live Platform credentials and static proxy as PYUSD (`TEKKO_LIVE_KEY_ID`, private key, `TEKKO_STATIC_PROXY_URL` / QuotaGuard, `TEKKO_WEBHOOK_SECRET`).

### 1. Proxy + auth smoke

```bash
npm run tekko:proxy-check
```

Expect signed `GET /ping` success through the static proxy.

### 2. Collections entitlement probe

```bash
npx tsx scripts/tekko-ngn-entitlement-check.ts
```

The script calls (read-only where possible):

1. `GET /collections/supported`
2. Optionally `GET /master-wallet/ng/virtual-account` if `TEKKO_NGN_ENTITLEMENT_PROBE_VA=1`
3. `GET /banks` (payout entitlement signal)

### 3. Migration

```bash
npm run db:migrate
```

Applies `0030_tekko_ngn_va` (VA status columns on `merchants`; no raw BVN stored).

## Record

| Environment | Date | `ngn_collections` | `ngn_payouts` | Notes |
|-------------|------|-------------------|---------------|-------|
| | | | | |
