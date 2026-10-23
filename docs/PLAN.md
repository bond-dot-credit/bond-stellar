# Plan: Stellar pooled vault that deposits into an RWA aggregator

Status: testnet deployed and exercised. Mainnet not started.

## 1. What it is

A pooled USDC vault on Stellar Soroban. Anyone can deposit USDC while the cap allows and
receives shares. A keeper agent moves the pooled USDC into a Soroban RWA aggregator, which
deploys it into existing RWA projects. Depositors withdraw from idle USDC.

## 2. Decisions

| # | Decision | Where it shows up |
|---|---|---|
| 1 | Aggregator on Soroban first | `AggregatorClient` trait in the vault; `mock-aggregator` stands in on testnet |
| 2 | KYC simulated for now | `kyc_open` flag, default open. `set_verified` for an allowlist |
| 3 | Anyone can deposit, 100 USDC total cap | `deposit` checks `total_assets + amount <= cap`; cap is a config value |
| 4 | Stellar mainnet is the target | Testnet is for development and tests |
| 5 | Standalone | No other chains or products |

## 3. Contracts (`contracts/`)

**`pooled-vault`**

- `deposit(user, amount) -> shares`: requires user auth, unpaused, KYC gate, cap check. Mints
  shares with virtual offset (`VIRTUAL_SHARES = 1e6`, `VIRTUAL_ASSETS = 1`).
- `withdraw(user, shares) -> amount`: never paused. Pays from idle USDC only; reverts with
  `InsufficientIdle` if idle is short.
- `agent_deploy(amount)`: agent auth. Sends USDC to the aggregator, keeping `buffer` idle.
- `agent_request_redeem(amount)` and `agent_claim()`: agent auth. Two-step redemption.
- Admin: `set_paused`, `set_cap`, `set_buffer`, `set_agent`, `set_kyc_open`, `set_verified`.
- Views: `total_assets`, `idle`, `total_supply`, `balance`, `preview_deposit`,
  `preview_withdraw`, and the config getters.

`total_assets = idle USDC + aggregator value_of(vault)`. A pending redemption still counts
toward the total while it settles.

**`mock-aggregator`** (testnet only)

- `deposit`, `request_redeem` (burns shares, sets a pending claim with unlock time),
  `claim`, `value_of`, `pending`. Admin `set_price` simulates yield. Redemption delay is
  configurable.

## 4. Invariants (covered by tests)

- Agent can only call the three agent functions, and only against the aggregator set at
  initialization.
- Nothing moves USDC to an address other than the depositor on withdraw, or the aggregator
  on deploy.
- Pause blocks deposits only.
- Cap cannot be exceeded by a single deposit.
- Agent deploys cannot push idle below the buffer.
- Withdrawals cannot exceed idle USDC.
- A first-depositor donation does not make the next deposit mint zero shares.

## 5. Agent (`agent/agent.mjs`)

Each tick:

1. If a redemption has passed its unlock time, claim it.
2. If idle is above the buffer by at least `MIN_MOVE_USDC`, deploy the surplus.
3. If idle is below the buffer by at least `MIN_MOVE_USDC` and nothing is pending, request
   a redemption for the shortfall, capped at the deployed value.

The agent is a keypair. The contract, not the agent, enforces the buffer, the cap, and the
aggregator address.

## 6. UI (`ui/`)

- Stellar Wallets Kit 2.7.0: Freighter, xBull, Albedo, Lobstr, and WalletConnect when a
  Reown project ID is set in `ui/config.json`.
- Shows total assets, cap usage, idle, deployed, buffer, KYC mode, and pause state.
- Deposit with a Max fill from the wallet balance. Withdraw 25%, 50%, or all shares.
- Activity log with links to transactions on stellar.expert.
- Bundled with esbuild so the wallet kit and its modules share one instance.

## 7. Testnet deployment

`scripts/deploy-testnet.sh` creates test identities, issues test USDC (a classic asset
wrapped in a Stellar Asset Contract), deploys and initializes both contracts, mints
test USDC to two test users, funds the aggregator for yield headroom, and writes
`deployments/testnet.json` and `ui/config.json`.

Mainnet uses Circle USDC and a real aggregator. Neither is pinned yet.

## 8. Simplifications (tracked as `ponytail:` comments)

| Simplification | Ceiling | Upgrade path |
|---|---|---|
| Shares are internal balances, not SEP-41 | Shares can't be transferred | Implement SEP-41 over the same balances |
| Vault calls the aggregator directly, no adapter contract | One aggregator | Add an adapter when a second aggregator is added |
| KYC is a flag | No real identity check | `KycProvider` contract called from `deposit` |
| Mock aggregator on testnet | Not a real RWA product | Integrate the chosen aggregator's interface |
| Single admin key | Admin is a single point of control | Multisig admin before any cap raise |

## 9. Remaining work before mainnet

1. Choose the aggregator and pin its mainnet contract address and interface.
2. Confirm whether the aggregator accepts a contract depositor or requires a verified human.
   This decides whether simulated KYC is enough.
3. Pin Circle USDC on Stellar mainnet and check it on-chain.
4. Real KYC provider, replacing the flag, before raising the cap.
5. External audit of the vault and its aggregator integration.
6. Multisig admin, and a runbook for pause, agent rotation, and the incident drill.
7. Counsel review: taking public deposits into RWA products is a regulated activity in
   most jurisdictions. The 100 USDC cap does not remove that requirement.
8. Wallet flows tested with real wallets on mainnet, starting with a small cap.
