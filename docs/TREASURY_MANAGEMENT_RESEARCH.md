# Treasury Management for Transacty — research & strategy

**Purpose:** a world-class treasury framework for managing **Transacty's own money — its profit** — across a multi-rail, multi-currency payments business. This is a **strategy/research paper**, not a dashboard spec: it defines the treasury functions a PSP of Transacty's shape must run, maps each to how the platform earns and holds money **today** (with file-level evidence), and flags the **data and process gaps** that must be closed before the profit can be measured, protected, and grown.

> Scope note: "our money" = the fees and margins Transacty earns, and the float it controls — **not** merchant balances (those are a liability, covered under safeguarding §3.9). The two are entangled in one ledger, which is itself the first treasury risk.

---

## 0. Executive summary

Transacty is a **multi-rail payment service provider (PSP)**: it collects money in and pays money out across Bangladesh (BDT/PayOK), Brazil (BRL/PIX/PayOK), India (INR→USDT/Tylt), Europe (EUR→USDC/Tylt), and on-chain crypto (USDT/USDC/Tylt CPG). It earns a **take** on this flow. A PSP is, financially, **a treasury business wearing a software coat** — the product is moving money, and the profit is the spread between what it charges and what the rails cost, held as float across many currencies with timing and FX risk in between.

Three findings shape everything below:

1. **Revenue is captured; cost and FX margin are not.** Platform fees post cleanly to a platform wallet as `platform_fee`/`monthly_fee` ledger entries ([fee-applier.ts:99](../src/lib/billing/fee-applier.ts#L99), [monthly-billing.ts:107](../src/lib/billing/monthly-billing.ts#L107)). But the **provider's cost** (PayOK `transFee`/`totalTransFee`, Tylt fees) is **never persisted**, and **FX spread margin** is written to transaction *metadata* only, never posted to the ledger ([cpg-payout.ts:245](../services/integrations/tylt/cpg-payout.ts#L245)). **Consequence: Transacty cannot compute its true net margin today.** You know gross fees, not profit.

2. **Float is real and multi-currency, but unmanaged as float.** Money physically sits in provider accounts (PayOK, Tylt) in BDT, BRL, USDT, USDC; the internal ledger mirrors it. Balance-at-provider queries exist ([payokBalanceQuery](../services/domestic/bangladesh/provider/client.ts#L94), [Tylt getAccountBalance](../services/integrations/tylt/discovery-balance.ts#L109)) but nothing reconciles them to the ledger, forecasts them, or sweeps them. There is **no reserve, no minimum-float policy, and no automated settlement to a company bank.**

3. **There is no platform-level treasury reporting.** `api/provider/` has a **per-merchant volume reconciliation report** ([reconciliation-report.ts](../src/lib/reconciliation-report.ts), [index.ts:2973](../api/provider/index.ts#L2973)) and an ops dashboard of **counts** (merchants, KYC, tx-status — [index.ts:237](../api/provider/index.ts#L237)) — but **no platform-wide revenue / margin / take-rate aggregation** by currency, rail, or period. The roadmap itself lists "Reconciliation Service", "Analytics & Reporting", and "Ops & Finance Dashboard" as **Future** ([ARCHITECTURE.md](ARCHITECTURE.md)). The raw material (a platform wallet per currency, a `platform_fee` ledger) exists; the measurement layer does not.

The rest of this paper is the framework to fix that — a treasury built on **one principle: you cannot manage profit you cannot measure, in currencies you cannot see, with timing you cannot predict.**

---

## 1. What "treasury" means for a PSP like Transacty

Corporate treasury has three classic mandates — **liquidity, funding, and risk**. For a PSP they specialize into:

| Treasury mandate | PSP translation | Transacty concretely |
|---|---|---|
| **Liquidity** | Always able to fund payouts and settlements on time, in the right currency | Enough BDT/BRL/USDT/USDC float at PayOK/Tylt to cover payouts before merchant funds settle |
| **Funding / working capital** | Finance the timing gap between paying out and getting paid | Payout debits merchant wallet *up front* ([cpg-payout.ts](../services/integrations/tylt/cpg-payout.ts)); but provider settlement timing creates float you finance |
| **Risk** | FX, counterparty, operational, and depeg risk on the money you hold | BDT/BRL are volatile EM currencies; USDT/USDC carry depeg/counterparty risk; single provider account = concentration |
| **Profit stewardship** | Recognize, protect, and repatriate margin | Recognize fee **and** spread revenue net of provider cost; convert/hedge; sweep to a company account |

The mental model is a **balance sheet**, not a transaction log:

```
ASSETS (what Transacty controls)        LIABILITIES (what it owes)
  Float at PayOK   (BDT, BRL)             Merchant wallet balances (settled)
  Float at Tylt    (USDT, USDC)           Pending pay-ins (in-flight, not yet owed)
  Platform wallet  (earned fees)          Provider fees payable
  Company bank     (repatriated profit)   Reserves held against chargebacks/failures
                                        ─────────────────────────────
  EQUITY = retained profit (the number this whole doc exists to grow)
```

Today Transacty's system expresses the **liability side well** (merchant/customer wallets, pending pay-ins) and the **asset/equity side poorly** (fees captured, but cost, FX P&L, provider float, and reserves are invisible). World-class treasury is the discipline of making the **whole** balance sheet true, timely, and controlled.

---

## 2. How Transacty earns and holds money today (grounded)

### 2.1 The revenue engine (captured well)

Every settled transaction can generate a **platform fee**. The fee applier debits the merchant's settlement wallet and credits a **platform wallet** in the same currency:

- Merchant wallet debit + platform wallet credit, both `type: "platform_fee"`, `referenceId = fee:{txId}:{feeType}` ([fee-applier.ts:99-129](../src/lib/billing/fee-applier.ts#L99)).
- The platform wallet is a **special merchant wallet** owned by `PLATFORM_MERCHANT_ID`, one **per currency, per environment** ([fee-applier.ts:72-81](../src/lib/billing/fee-applier.ts#L72), [platform-wallet.ts](../src/lib/billing/platform-wallet.ts)). Note: `wallet_type` enum is only `merchant | customer` ([schema](../src/db/schema/index.ts#L26)) — the platform "account" is modeled as a merchant, which works but blurs the asset/liability line (see §3.9 gap).
- Fees are computed from **fee schedules** (percentage / flat / min / max, billing modes) per rail/currency ([fee-calculator](../src/lib/billing/fee-calculator.ts), [fee-schedules](../src/lib/billing/fee-schedules.ts)).
- A **subscription** revenue line also exists: `monthly_fee` ledger entries ([monthly-billing.ts:107](../src/lib/billing/monthly-billing.ts#L107)).

**So gross revenue is knowable:** it is the sum of `platform_fee` + `monthly_fee` **credits** to the platform wallet, groupable by currency, rail (via `provider`), and merchant. This is a genuine strength — the raw ledger is clean.

### 2.2 The margin engine (NOT captured — the core gap)

Profit = **revenue − cost**. Transacty captures revenue but not the two cost/margin components:

- **Provider cost is dropped — and the two providers drop it differently.** PayOK returns `transFee`/`totalTransFee`/`transFeeRate` on every order and callback ([payok-payin-reference.md](providers/payok-payin-reference.md), [payok-payout-reference.md](providers/payok-payout-reference.md)), but the callback handlers **don't even read those fields** — they're omitted from the handler body types ([payin.ts:103](../services/domestic/bangladesh/payin.ts#L103), [payout.ts:339](../services/domestic/bangladesh/payout.ts#L339)), so PayOK cost is discarded at the door. Tylt cost is subtler: it's **latent in metadata but never extracted** — EUR payout stores `quoteRate`/`quoteCryptoAmount`, and CPG webhooks expose `settledAmountDebited`/`settledAmountSent`, from which Tylt's take is derivable — but nothing computes or ledgers it. → **Net margin is uncomputable for PayOK (data gone) and merely un-computed for Tylt (data stranded in JSON).** Either way, you fly on gross revenue.
- **FX spread margin is captured in metadata only, not the ledger.** The spread *policy* is real and in the DB — `fxRateProfiles` (`spread_bps`, `spread_mode` `on_output`/`on_rate`) and `merchantFxOverrides` ([schema](../src/db/schema/index.ts#L256), [rate-resolver.ts](../src/lib/fx/rate-resolver.ts)). But the *realized* spread per transaction is written only to **transaction metadata** — `fxSpreadAmount`/`fxSpreadBps` on crypto/EUR payouts ([cpg-payout.ts:245](../services/integrations/tylt/cpg-payout.ts#L245), [eur-payout.ts:282](../services/integrations/tylt/eur-payout.ts#L282)) — with **no ledger entry** crediting it to the platform wallet. The merchant is debited it, but it is **unrecognized revenue** sitting as an unexplained surplus in provider float: economically earned, financially invisible, and a **reconciliation break waiting to happen**.

This is the single most important treasury gap: **two of the three profit components (spread, and the cost that turns gross into net) are not in the ledger.**

### 2.3 Where the money physically sits (float)

| Currency | Rail / provider | Nature | Where float lives |
|---|---|---|---|
| BDT | Bangladesh / PayOK | Fiat (wallet) | PayOK merchant balance |
| BRL | Brazil / PayOK | Fiat (PIX) | PayOK merchant balance |
| USDT | India / Tylt | Stablecoin | Tylt account holdings |
| USDC | Europe / Tylt | Stablecoin | Tylt account holdings |
| INR, EUR | India / Europe | Pass-through (payer/beneficiary side) | Converted at provider |

The **internal ledger wallets mirror** this, but the truth of "how much money does Transacty actually have at each provider" is only obtainable by calling the provider: [payokBalanceQuery](../services/domestic/bangladesh/provider/client.ts#L94) (returns `availableBalance` and, per PayOK's spec, withdrawing/settling balances) and [Tylt getAccountBalance](../services/integrations/tylt/discovery-balance.ts#L109) / getMerchantDetails. These exist but their **only** callers are a connectivity/test script and a merchant-facing balance passthrough — **no scheduled treasury job calls them, stores them, reconciles them, or acts on them.** For treasury purposes the provider float is invisible.

### 2.4 Settlement & repatriation (manual/external)

There is **no sweep or withdrawal automation** (grep for sweep/withdraw/holdback returns nothing relevant). Moving earned money from PayOK/Tylt to a Transacty company bank account is an **out-of-band, manual** action. That means retained profit is invisible to the system and its timing is undocumented — a governance gap.

### 2.5 Summary of the current state

| Treasury capability | State today |
|---|---|
| Gross fee revenue by currency/rail/merchant | ✅ Derivable from `platform_fee`/`monthly_fee` ledger |
| Provider cost per transaction | ❌ Dropped (not persisted) |
| FX spread revenue recognition | ⚠️ In metadata, not ledger |
| True net margin | ❌ Not computable |
| Multi-currency float visibility | ⚠️ Queryable from providers, never stored/reconciled |
| Ledger ↔ provider ↔ bank reconciliation | ❌ None (only tx-status reconcile) |
| Reserves / buffers / min-float | ❌ None |
| Settlement/repatriation | ❌ Manual, off-system |
| Revenue/profit reporting | ⚠️ Per-merchant volume reconciliation only; no platform revenue/margin aggregation |
| FX exposure / hedging | ❌ None |
| Cash-flow forecasting | ❌ None |

---

## 3. The full treasury stack (the framework)

Each function: **(P) principle & world-class practice → (T) how it applies to Transacty → (G) current state & the gap to close.**

### 3.1 Revenue recognition & profit accounting

**(P)** World-class treasuries recognize revenue on an **accrual, component-decomposed** basis: every unit of income is classified (transaction fee, FX spread, subscription, interest on float) and matched to the period and cost that produced it. Gross vs **net revenue** (after provider cost and refunds/reversals) is the headline number; "take rate" (net revenue ÷ processed volume) is the KPI executives live by.

**(T)** Transacty's income has (at least) four components: **transaction fees** (`platform_fee`), **FX spread** (crypto/EUR payouts), **subscription** (`monthly_fee`), and — once float is managed — **yield on float**. Each should be a distinct, ledgered revenue type, recognized when the underlying transaction settles (`success`), and **reversed** when a payout fails/refunds (`payout_refund`) so revenue isn't overstated.

**(G)** Fees and subscriptions are ledgered; **spread is not** (metadata only), and there is **no revenue reversal discipline tied to failures**. Gap: (a) post FX spread as a `platform_fee`-class ledger credit at recognition time; (b) ensure fee reversal on `payout_refund`/failure; (c) tag every revenue entry with its component so gross/net/take-rate are queryable.

### 3.2 Provider cost & true net margin

**(P)** You cannot run a payments business on gross revenue — the rail cost is the largest variable expense, and it **varies by method, corridor, and volume tier**. Best practice captures **cost-of-payment per transaction** and computes **contribution margin** per transaction, merchant, and corridor, so unprofitable flows are visible immediately (a merchant on a low fee over an expensive method can be **loss-making** — you must be able to see it).

**(T)** PayOK hands you the cost on a plate: `transFee`/`totalTransFee`/`transFeeRate` on every order and callback. Tylt's cost is embedded in its rate/`cryptoAmount`. Capturing these lets Transacty compute, per transaction: `net_margin = platform_fee + fx_spread − provider_cost`.

**(G)** **Provider cost is discarded** — the highest-value quick win in this entire document. Gap: persist `totalTransFee` (and the FX cost implied by Tylt's rate) on the transaction (metadata at minimum, ideally a `provider_cost` ledger entry against a cost account), so net margin becomes a first-class, reportable number. Until this exists, **every "revenue" figure is an illusion of profit.**

### 3.3 FX exposure & hedging

**(P)** A treasury holding balances in multiple currencies has an **open FX position** it must measure (net exposure per currency), decide a **policy** on (hold, convert-on-receipt, or hedge), and mark-to-market. Volatile EM currencies (BDT, BRL) are typically **converted quickly** ("sweep to hard currency") to avoid holding depreciation risk; stablecoins (USDT/USDC) carry **depeg and issuer counterparty** risk that must be sized and, ideally, diversified.

**(T)** Transacty earns and holds fees in **BDT, BRL, USDT, USDC**. If its accounting/reporting currency is USD (or a founder-home currency), it is **long BDT and BRL** (depreciation risk) and **long stablecoins** (depeg risk). The FX spread it charges merchants is itself an FX revenue line — but the **residual balance** is an unhedged position.

**(G)** No exposure measurement, no conversion policy, no hedging. Gap: (1) compute **net position per currency** daily (from platform-wallet + float balances); (2) set a **policy** — e.g. auto-convert BDT/BRL fee income to USDC/USD above a threshold, cap stablecoin holdings per issuer; (3) track **FX P&L** (realized on conversion, unrealized on holdings) as a treasury line separate from the customer-facing spread revenue.

### 3.4 Multi-currency float & liquidity management

**(P)** Liquidity management ensures **every payout can be funded, in the right currency, at the right time**, without stranding excess cash that could be earning yield or repatriated. Best practice runs a **per-currency liquidity ladder**: available balance, committed outflows (queued payouts), expected inflows (settling pay-ins), and a **minimum operating float** buffer per rail.

**(T)** Because payouts **debit the merchant wallet up front** before the provider call ([cpg-payout.ts](../services/integrations/tylt/cpg-payout.ts), [bangladesh/payout.ts](../services/domestic/bangladesh/payout.ts)), the internal ledger can't overdraft a merchant — good. But **Transacty's own provider float** can still run dry (e.g. many BRL payouts before BRL pay-ins settle at PayOK), which fails payouts at the provider even though the ledger looks fine. Liquidity must be watched **at the provider-balance layer**, per currency.

**(G)** Provider balances are never polled/stored, so **liquidity is invisible until a payout fails**. Gap: schedule provider-balance capture per currency; define **minimum float thresholds** per rail; alert when available float < (queued payouts + buffer). This is where the existing [circuit breaker](../src/lib/provider-circuit-breaker.ts) philosophy should extend from "provider is erroring" to "provider float is low".

### 3.5 Settlement timing & the cash-conversion cycle

**(P)** The **cash-conversion cycle (CCC)** — how long money is tied up between paying out and being paid — is the beating heart of PSP working capital. Treasuries measure **float days** per rail (how long funds sit at the provider before you can withdraw), **DSO** (days sales outstanding on fees), and design operations to shorten the cycle or **get paid for financing it** (that's what the spread and fees compensate).

**(T)** Each rail has different settlement mechanics: PayOK reports `availableBalance` vs settling/withdrawing states (money isn't instantly withdrawable); Tylt stablecoin settlement has its own timing. Transacty is implicitly **financing float** whenever it pays out before the corresponding funds are withdrawable — with no measurement of how much, for how long, or at what cost.

**(G)** No float-day or CCC measurement. Gap: capture provider settlement states over time to compute **float days per rail** and the **peak intraday float** Transacty must fund — the number that tells you how much working capital the business actually consumes.

### 3.6 Reserves, buffers & risk capital

**(P)** PSPs hold **reserves** against realized risks: **rolling reserves** (a % of volume held back for a window against chargebacks/refunds/failed payouts), **minimum operating buffers** per currency, and **risk capital** against provider default or depeg. A world-class treasury sizes these from **actual loss/failure data**, not guesswork.

**(T)** Transacty's exposures: payout failures (handled today by `payout_refund` — good, the debit is returned), merchant disputes, provider insolvency, and **stablecoin depeg** on held USDT/USDC. None of these are pre-funded by a reserve; a loss would hit the platform wallet directly.

**(G)** Risk *velocity* controls exist ([fraud-policy.ts](../src/lib/fraud-policy.ts): per-hour pay-in caps, per-recipient payout caps, a daily BDT payout-volume cap) — but these throttle **abuse**, not **treasury risk**; there is no reserve/holdback/min-float concept anywhere. Gap: (1) a **minimum-float policy** per currency (don't let earned profit be swept below an operating buffer); (2) optionally a **rolling reserve** ledger account per merchant for high-risk merchants; (3) a sized, monitored **stablecoin exposure cap**.

### 3.7 Reconciliation & the three-way tie-out

**(P)** The non-negotiable control of any money business: **three-way reconciliation** — the internal ledger must tie to the **provider's records** must tie to the **bank/settlement account**, every day, with **breaks investigated and aged**. "Reconciled" means every unit of money is explained by an entry; unexplained differences are treated as potential loss or fraud until cleared.

**(T)** Transacty has **transaction-status** reconciliation (does our tx match the provider's tx state — [payin-reconcile.ts](../services/domestic/bangladesh/payin-reconcile.ts), `repairMisCreditedPayinWallet`) — this is valuable but it is **not balance reconciliation**. The treasury-critical question — *"does our internal ledger balance per currency equal the provider's reported balance, and is the difference exactly our unrecognized spread + in-flight items?"* — is never asked.

**(G)** No ledger-vs-provider-balance reconciliation; and because **spread and provider cost aren't ledgered (§2.2)**, the ledger *can't* tie to the provider balance even in principle — the difference would be exactly the unrecognized margin. Gap: (1) close the recognition gaps in §3.1–3.2 so the ledger is complete; (2) then run a **daily per-currency tie-out**: `ledger platform + merchant balances == provider available + settling ± in-flight`, with aged break tracking.

### 3.8 Cash-flow forecasting & liquidity planning

**(P)** Treasuries forecast **inflows and outflows per currency** over rolling horizons (intraday, 1-day, 1-week) to pre-position liquidity, schedule conversions/hedges cheaply, and avoid emergency funding. Even a simple forecast (trailing volume × settlement timing) prevents most liquidity surprises.

**(T)** Transacty has the raw signal: pay-in/payout volumes per rail, settlement timing, and merchant behavior are all in the transactions table. A forecast would answer "will we have enough BRL float on Friday given queued payouts and typical Thursday pay-in settlement?"

**(G)** None. Gap: a per-currency short-horizon projection from trailing flow + settlement lag — the input to the liquidity thresholds in §3.4.

### 3.9 Controls, governance, segregation & audit

**(P)** Money movement demands **segregation of duties** (the person who initiates a payout/sweep ≠ the one who approves it — maker/checker), **safeguarding** (customer funds ring-fenced from company funds), **immutable audit trails**, and **least-privilege access** to treasury actions. Regulators and banking partners require the platform's **own money to be distinguishable from customers' money** at all times.

**(T)** Transacty has strong primitives: an **audit trail** ([audit.ts](../src/lib/audit.ts)), provider-admin RBAC ([provider-auth.ts](../src/lib/provider-auth.ts)), and idempotent, atomic ledger writes with money invariants ([MONEY_INVARIANTS.md](MONEY_INVARIANTS.md)). But two structural issues: (1) the **platform "wallet" is modeled as a merchant** (`PLATFORM_MERCHANT_ID`, `type: "merchant"`) — functionally fine, but it **commingles company funds with customer funds in the same table/type**, which safeguarding best practice (and likely future licensing) wants **cleanly separated**; (2) any **sweep/repatriation** (once built) is a high-risk action that needs **maker-checker**, not a single-actor API call.

**(G)** Gap: (1) treat the platform account as a distinct **class** (even if same table, a clear `platform`/company designation and reporting separation) so safeguarding and audits can draw the customer-vs-company line; (2) design future treasury actions (sweep, convert, adjust) as **maker-checker** with full audit; (3) restrict treasury reporting/actions to a dedicated provider-admin role.

---

## 4. The treasury KPI set (what "world-class" measures)

A treasury is run off a small, ruthless set of numbers. For Transacty, per **currency** and per **rail** (and where relevant per merchant):

| KPI | Definition | Why it matters | Computable today? |
|---|---|---|---|
| **Processed volume** | Σ pay-in + payout amounts | Denominator for everything | ✅ |
| **Gross revenue** | Σ `platform_fee` + `monthly_fee` + spread | Top line | ⚠️ (spread missing) |
| **Provider cost** | Σ `totalTransFee` + FX cost | Largest variable cost | ❌ |
| **Net revenue / take rate** | (Gross − cost) ÷ volume | The profit headline | ❌ |
| **Contribution margin** | Net revenue per merchant/corridor | Finds loss-making flows | ❌ |
| **FX P&L** | Realized + unrealized on held currencies | Hidden gain/loss | ❌ |
| **Float balance & float days** | Provider balance; days funds are tied up | Working-capital load | ❌ |
| **Liquidity coverage** | Available float ÷ (queued payouts + buffer) | Payout-failure early warning | ❌ |
| **Reconciliation break** | Unexplained ledger↔provider↔bank diff, aged | Fraud/loss control | ❌ |
| **Reserve coverage** | Reserves ÷ trailing failure/refund losses | Solvency cushion | ❌ |
| **Repatriated profit** | Swept to company bank per period | Realized equity | ❌ |

The pattern is stark: **the operational numbers (volume, gross fees) are computable; every profit/risk number is not** — because the cost, spread, and float data aren't captured. Fixing §2.2 unlocks most of this column.

---

## 5. Treasury maturity model (crawl → walk → run)

| Stage | Capability | What Transacty must add |
|---|---|---|
| **1. Visibility (crawl)** | Know what you earn and hold | Persist provider cost; ledger the FX spread; aggregate `platform_fee`/`monthly_fee` into a revenue view; poll & store provider balances |
| **2. Truth (walk)** | Reconcile & recognize correctly | Daily per-currency 3-way tie-out; revenue reversal on failures; net-margin per tx/merchant/rail; FX exposure snapshot |
| **3. Control (walk→run)** | Protect the profit | Minimum-float thresholds + liquidity alerts; reserves policy; stablecoin exposure caps; maker-checker on money actions |
| **4. Optimization (run)** | Grow & de-risk the profit | FX conversion/hedging policy; cash-flow forecasting; automated sweeps/repatriation; yield on idle float; corridor-level pricing driven by contribution margin |

**The ordering is non-negotiable:** you cannot control or optimize what you cannot yet see or trust. **Stage 1 is the prerequisite for everything**, and its cornerstone is **capturing provider cost and ledgering the spread** — without which "profit" is unmeasured.

---

## 6. The critical data gaps to close first (prioritized)

Ranked by leverage — each unlocks a cluster of the framework above:

1. **Persist provider cost** (`totalTransFee`, Tylt FX cost) per transaction. → Unlocks net margin, take rate, contribution margin, and reconciliation. *Highest leverage, lowest effort — the data is already in the API responses; it's just being thrown away.*
2. **Ledger the FX spread** as recognized platform revenue at settlement. → Makes revenue complete and lets the ledger tie to provider balances.
3. **Capture provider balances on a schedule** per currency/rail. → Unlocks float visibility, liquidity coverage, and the three-way tie-out.
4. **Revenue reversal on payout failure/refund.** → Stops overstating profit.
5. **A per-currency reconciliation** (`ledger == provider ± in-flight`). → The core money-integrity control.
6. **A minimum-float / reserve policy** and exposure caps. → Turns visibility into protection.

Items 1–2 are small, contained changes to the fee/payout paths; items 3–6 are new treasury processes. **Do 1–2 first: they convert every existing "revenue" number from gross to true, retroactively making the whole business measurable.**

---

## 7. Transacty-specific risks a treasury must own

- **Unmeasured net margin.** The business could be scaling *gross* revenue while a rail or merchant is *net* loss-making, and nothing would reveal it until cash ran short. (Directly caused by §2.2.)
- **Unrecognized spread → reconciliation drift.** The FX spread accrues as an unexplained surplus in provider float; over time the ledger and provider balances diverge by exactly this amount, masking real breaks (and real losses/fraud) inside "expected" noise.
- **Concentration on single provider accounts.** All BDT/BRL float sits at PayOK, all USDT/USDC at Tylt. A provider freeze, insolvency, or account issue is an existential liquidity event with **no diversification and no reserve**.
- **Stablecoin depeg / issuer risk.** Held USDT/USDC is exposed to depeg and issuer counterparty risk — an unhedged, uncapped position on the asset side of the balance sheet.
- **EM currency depreciation.** BDT and BRL fee income held un-converted loses value; the longer the float sits (unmeasured float days), the larger the silent FX loss.
- **Commingled company vs customer funds.** The platform account living as a `merchant` wallet blurs the safeguarding line — a compliance and licensing risk as Transacty grows.
- **Off-system repatriation.** Manual sweeps with no maker-checker and no ledger record are a governance and fraud-surface gap on the most sensitive action a treasury performs.

---

## 8. Closing thesis

Transacty has built an **excellent transaction ledger** — atomic, idempotent, invariant-guarded, multi-currency. That is the hard part, and it is done well. What it has **not** yet built is the **treasury layer that sits on top of the ledger and turns flow into measured, protected, growing profit.** The gap is not primarily engineering difficulty; it is that three of the four profit components (provider cost, FX spread recognition, and float yield) and the entire risk/liquidity view are **not captured**.

World-class treasury for Transacty is, in one sentence: **make the whole balance sheet true (capture cost, spread, and float), reconcile it daily across ledger–provider–bank, protect it with reserves and FX policy, and only then optimize it.** The first, highest-leverage move is the smallest: **stop discarding the provider cost and the spread you already compute** — the moment those are in the ledger, Transacty can, for the first time, see its actual profit.
