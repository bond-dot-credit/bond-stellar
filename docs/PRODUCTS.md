# bond.credit — Product Line on Stellar

Market context for all products: see the RWA market notes (USDY, BENJI, Spiko, Blend lending).
Referenced throughout, not duplicated here.

---

## Product A — RWA Yield Vault (flagship)

**Description**
A pooled USDC vault on Stellar where anyone deposits, receives shares, and earns RWA yield
(tokenized Treasuries / money market funds). A keeper agent keeps a liquidity buffer undeployed
so withdrawals settle instantly; the rest earns. This is the productized version of what
bond-stellar already is.

**Architecture**

```
Wallet (Freighter/xBull/...)
   │
   ▼
pooled-vault (Soroban) ──shares──► depositor
   │
   ├── USDC (Circle on mainnet)
   ├── AggregatorClient trait ◄── pinned RWA venue (adapter per venue)
   │
agent.mjs (keeper) ──tick──► claim → deploy surplus → recall shortfall
   │
Console (static UI) ──► dashboard, venues, activity, admin
```

**What we have today**

- Complete vault contract: deposits, withdrawals from idle, cap, buffer, pause, simulated
  KYC, virtual-offset share math with first-depositor protection
- Agent with a proven tick loop and a real testnet deployment exercised end-to-end
  (deposit → deploy → redeem → claim → exit)
- Console with wallet connect, role gating, events feed
- Mock aggregator implementing the exact four-function interface a real venue adapter needs

**What to build (milestones)**

- **M1 — Venue decision:** pick the mainnet aggregator from the RWA market notes; confirm it
  accepts a contract depositor
- **M2 — Adapter contract:** wrap the chosen venue behind the existing
  `deposit / request_redeem / claim / value_of` interface so the vault needs zero logic changes
- **M3 — Ops hardening:** multisig admin, agent rotation runbook
- **M4 — Mainnet launch:** pin Circle USDC, external audit, small cap launch, raise cap
  progressively

---

## Product B — Transferable Share Token (SEP-41)

**Description**
Today shares are internal ledger entries — they can't move between wallets. Make the vault share
a real SEP-41 token and every deposit becomes a tradeable, composable asset: secondary transfers,
DEX liquidity, collateral in lending protocols (e.g. Blend, see market notes), integrations with
other Stellar DeFi.

**Architecture**

```
pooled-vault
   ├── internal share accounting (unchanged, rounding still favors pool)
   └── share-token contract (SEP-41 wrapper)
          ├── mint/burn — vault only
          ├── transfer/allowance — anyone (composability surface)
          └── metadata: asset = vault address (redeem rights live in vault)
```

Deposit/withdraw flows unchanged; `Shares(addr)` becomes a balance read through the token
contract.

**What we have today**

- The accounting math is already isolated — mint/burn happens in exactly two functions
  (`deposit`, `withdraw`), so tokenizing is a wrapping exercise, not a rewrite
- Vault events already emit everything a token indexer needs
- Documented upgrade path exists in `docs/PLAN.md` (SEP-41 row in the simplifications table)

**What to build (milestones)**

- **M1 — Share token contract:** SEP-41 interface over the vault's balances; vault becomes the
  only minter/burner
- **M2 — Transfer gating decision:** decide if transfers are unrestricted or routed through a
  guard (fee, allowlist, or lock-up) — a product decision, not just a technical one
- **M3 — Composability integrations:** DEX pool for shares/USDC, collateral listing on a
  lending protocol
- **M4 — Deprecate internal balances** after migration testing

---

## Product C — Multi-Strategy Vaults (vault marketplace)

**Description**
The aggregator interface is venue-agnostic. Run several vault instances in parallel — one per
strategy (Treasuries, money market funds, private credit; see the venue landscape in the market
notes) — behind one console and one agent. Users pick a risk/yield profile per vault; bond.credit
earns fees across all of them.

**Architecture**

```
                    ┌── Vault A ──► Adapter 1 ──► Venue 1 (Treasuries)
Console (one UI) ───┼── Vault B ──► Adapter 2 ──► Venue 2 (MMF)
                    └── Vault C ──► Adapter 3 ──► Venue 3 (credit)

Agent (one process, multi-instance)
   └── config: [ {vault, buffer, min_move}, ... ]  ← one entry per vault
```

**What we have today**

- Vault and agent are already parameterized and stateless-per-instance; running N of them is an
  ops config, not code
- The adapter seam exists (AggregatorClient trait); each new venue is one adapter contract
- Console is config-driven — needs a multi-vault config schema rather than a rewrite

**What to build (milestones)**

- **M1 — Agent multi-instance support:** config array instead of single-vault env vars;
  per-vault tick state
- **M2 — Adapter per venue:** each venue from the market notes gets its adapter (redemption
  delays and venue rules differ per venue — this is the real work)
- **M3 — Console multi-vault:** vault switcher, per-vault dashboard/venues pages, aggregated
  portfolio view for a connected wallet
- **M4 — Fee layer:** management/performance fee taken in the vault contract, per-vault
  configurable

---

## Product D — Embedded Savings API

**Description**
Headless version of the vault: a REST/JS SDK so wallets, neobanks, and remittance apps offer
"earn on USDC" inside their own product without touching our console. Stellar's sub-cent fees
and fast settlement are the pitch versus deploying on Ethereum L2s. The agent and vault stay
exactly as they are — this is a new interface layer on top.

**Architecture**

```
Partner app ──► bond-api (REST/JS SDK)
                    ├── deposit(user, amount)   ──► pooled-vault
                    ├── withdraw(user, shares)  ──► pooled-vault
                    ├── balance / APY / history ──► RPC + events index
                    └── webhook: deposits, withdrawals, yield accrual

Existing stack untouched: vault, agent, console (now one "channel" among many)
```

**What we have today**

- `ui/lib/soroban.js` is already a clean shared chain client used by the console, agent, and
  smoke tests — it *is* the kernel of the SDK
- All state is readable on-chain (views + events), so an API layer is thin
- Role model (admin/agent/user) already separates concerns an API needs to respect

**What to build (milestones)**

- **M1 — SDK package:** extract `soroban.js` into a published npm package
  (`@bond.credit/sdk`): deposit, withdraw, preview, balance
- **M2 — API service:** hosted REST API with API keys, per-partner deposit addresses,
  idempotency, webhook events (needs an events indexer — the console's bounded events window
  is the known gap to close)
- **M3 — Partner onboarding:** self-serve API key issuance, per-partner configuration,
  usage dashboards
- **M4 — White-label console:** hosted, brandable version of the existing UI per partner

---

## Product E — White-Label Vaults for Businesses — TBD

**Description**
Any company holding USDC on Stellar (remitters, marketplaces, payroll providers) gets its own
branded vault plus a managed agent: their corporate treasury auto-deploys into RWA yield with
the buffer managed automatically. The vault/agent/console stack is already multi-instance
ready, so this is largely a packaging and ops play.

**Status: TBD** — overlaps with Products C and D (multi-instance ops from C, partner
distribution from D). Revisit once A ships and D has its first partners; the decision is
whether white-label vaults are a separate SKU or just a D-tier plan.

---

## Delivery order across products

A (vault mainnet) is the prerequisite for everything. B (share token) rides on A. C multiplies
A and B per venue. D monetizes A/B/C through partners. Recommended sequence: **A → B → D → C** —
D before C because one venue plus an API reaches more users than three venues with no
distribution. E stays TBD until D proves partner demand.
