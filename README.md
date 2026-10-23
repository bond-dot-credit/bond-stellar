# bond-stellar

A pooled USDC vault on Stellar Soroban. Anyone can deposit up to a cap and receive shares.
A keeper agent moves the pooled USDC into a Soroban RWA aggregator. Depositors withdraw from
idle USDC.

Testnet only for now. Mock aggregator, test USDC, and simulated KYC.

- Plan: [docs/PLAN.md](docs/PLAN.md)
- Contracts: [contracts/](contracts/) (Soroban, Rust)
- Agent: [agent/agent.mjs](agent/agent.mjs) (Node, `@stellar/stellar-sdk`)
- Console: [ui/](ui/) (static page, Stellar Wallets Kit)

## Layout

```
contracts/
  pooled-vault/       vault: deposits, shares, cap, KYC gate, agent functions
  mock-aggregator/    testnet stand-in for an RWA aggregator
agent/agent.mjs       keeper loop: claim, deploy surplus, recall shortfall
ui/
  index.html          console markup and styles (Dashboard, Venues, Activity, Transactions, Admin)
  src/app.js          wallet connect, role gating, pool state, admin actions, tour
  lib/soroban.js      shared client used by the console, agent, and smoke test
  config.json         deployment config, written by the deploy script
scripts/
  deploy-testnet.sh   deploy everything to testnet and write the config files
  smoke-testnet.mjs   end-to-end flow through the shared client
  build-ui.mjs        bundles ui/src into ui/dist
  serve-ui.mjs        serves ui/ on localhost
deployments/testnet.json   contract and account addresses (public, no secrets)
```

## Prerequisites

- Node 20+
- Rust with the `wasm32v1-none` target: `rustup target add wasm32v1-none`
- Stellar CLI (tested with 28.1.0): `brew install stellar-cli`
- Freighter or another Stellar wallet set to testnet, for the UI

## Run the testnet demo

```bash
npm install

# 1. Contract tests
npm run test:contracts

# 2. Deploy to testnet (idempotent identities; deploys new contracts each run)
npm run deploy:testnet

# 3. Build and serve the UI
npm run build:ui
npm run ui          # http://localhost:8080

# 4. Run the agent (needs the agent's secret key)
AGENT_SECRET="$(stellar keys secret stellar-agent)" npm run agent:once
AGENT_SECRET="$(stellar keys secret stellar-agent)" npm run agent   # continuous

# 5. End-to-end smoke test through the same client the UI uses
npm run smoke:testnet
```

In the console, connect a wallet on testnet. The wallet needs a USDC trustline and test USDC
minted to it. The deploy script mints 200 test USDC (2,000,000,000 base units) to `stellar-alice` and `stellar-bob`.
To use one of them, import its secret into Freighter with `stellar keys secret stellar-alice`.

WalletConnect is optional. It needs a Reown project ID. Create one at https://cloud.reown.com, then copy
`ui/wallet.example.json` to `ui/wallet.json` and set `walletConnectProjectId`. The deploy script never
touches that file. Without an ID the wallet picker still lists Freighter, xBull, Albedo, and the other
installed wallets, but not WalletConnect.

The console checks that the wallet is on the same network before it connects, and refuses to sign if the
wallet has switched accounts since connecting.

The console has no key field. Connect from the top-right button. It signs through the wallet, so keys are never stored in the browser.
Admin pages only open for the admin wallet, GD3XOPCLWPJDGCYR6U36WKWSITTQZDM7IDO7I6YB5SZJJIIUS4BRAXB5. The manual deploy and redemption
controls need the agent wallet (`stellar-agent`). Pages can be opened directly with `?view=activity`,
`?view=transactions`, `?view=venues`, or `?view=admin`.

## Parameters

| Name | Where | Default (testnet) |
|---|---|---|
| Cap | `CAP` env in deploy script, `set_cap` | 1,000,000,000 (100 USDC) |
| Buffer | `BUFFER` env in deploy script, `set_buffer` | 100,000,000 (10 USDC) |
| Redemption delay | `DELAY` env in deploy script | 60 seconds |
| Agent move threshold | `MIN_MOVE_USDC` env for agent | 1 USDC |
| Agent tick | `TICK_SECONDS` env for agent | 60 |

USDC uses 7 decimals on Stellar, so 1 USDC = 10,000,000 base units.

## Security notes

- The agent key can only call the vault's three agent functions. Those can only move USDC
  between the vault and the pinned aggregator.
- Pause blocks deposits. Withdrawals are never paused.
- KYC is simulated and open to everyone. Do not raise the cap until a real provider replaces it.
- The admin key is a single key. Use a multisig before any real deployment.
- Secret keys live in the Stellar CLI keystore, never in the repo.

## Status

- Contracts: 11 unit tests passing (`npm run test:contracts`).
- Testnet: deployed and exercised. Deposit, agent deploy, agent redemption request, claim
  after delay, and withdraw were all run on-chain. See `deployments/testnet.json`.
- Console: renders Dashboard, Venues, Activity, and Transactions from live testnet state
  (headless Chrome). Activity and Transactions are built from on-chain vault events.
- Not yet run in a browser with a real wallet: connect, sign, deposit, withdraw, and the
  admin pages. The transaction path is the same one the smoke test runs through the shared client.
- Not started: mainnet, audit, real aggregator, real KYC.
