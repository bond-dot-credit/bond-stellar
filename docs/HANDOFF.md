# Meridian demo handoff

Updated 2026-10-26. Branch: `meridian-demo`. No contracts changed, deployments run, or merge into main performed.

## Current implementation

- Soroban vault supports authenticated deposits, internal shares, idle-only withdrawals, deposit cap, deposit pause, and simulated KYC gating.
- Agent authorization and the pinned aggregator restrict allocations. Allocation must leave a **fixed USDC buffer**, default 10 USDC; a 20% minimum is proposed and absent from the contracts. Withdrawals may consume the buffer.
- Keeper claims settled redemptions, deploys surplus above the buffer, and recalls buffer shortfalls. It is deterministic, not a multi-venue AI allocator.
- Wallet signing, faucet, pool views, event history, and transaction links are wired through the shared client. Real wallet execution remains to be verified in this session.
- Token is custom faucet-funded test USDC, not Circle USDC. Aggregator and admin-controlled yield are mocks. Displayed balances/events come from testnet when RPC reads succeed; they do not demonstrate real RWA investment. Shares are not transferable tokens; KYC is a flag/allowlist.

## Changes made

- Added persistent demo explanation and explicit mock labels.
- Added successful-read ledger/time and stale-read feedback.
- Added fixed-buffer, pending recall, and full-exit liquidity guidance.
- Added transaction preparation, wallet approval, confirmation link, and readable failure feedback. Generic errors avoid displaying raw provider responses; simulation rejection is distinguished from confirmed execution.
- Preserved existing transaction calls, keeper policy, contract code, and dependency versions. UI feedback is session-local, not a durable transaction index.

## Verification

- User completed `npm ci` successfully in a separate Terminal.
- `npm run build:ui`: passed here after installation and after UI edits. Bundle approximately 5.8 MB, source map 10.3 MB; optimize later if demo loading is slow.
- JavaScript syntax checks and `git diff --check`: passed.
- `npm run test:contracts`: blocked by missing cargo/Rust. Stellar CLI is also unavailable for contract builds. Existing source contains 13 vault tests and 2 token tests; README's 11-test count is stale. No current passing Rust result is claimed.
- `npm run ui`: blocked here by socket sandbox permissions (`listen EPERM`, port 8080). Start from a normal Terminal; expected URL http://localhost:8080. Browser and real-wallet checks have not run.
- Deployed app/RPC and npm audit endpoint inaccessible here due to DNS restrictions.

## Dependency review

`npm audit --json` could not retrieve advisories (registry DNS failure). No verified vulnerability counts or severities are available. Capture the report in a network-enabled Terminal and assess advisory paths/reachability before upgrades; do not run a forced audit fix.

Observed deprecations: transitive `uuid@8.3.2` and `@safe-global/safe-gateway-typescript-sdk@3.23.1`, both under wallet-kit dependencies. These are maintenance signals, not proof of exploitable vulnerabilities. Wallet-kit includes broad optional wallet/network dependency trees; assess browser-reachable signing and connection code separately from Node/build-only paths. Avoid overrides without compatibility and wallet regression checks.

## Next tasks, in priority order

1. Run locally and rehearse connect → fund XLM → faucet → deposit → receive shares → keeper allocation → rejected allocation → recall → withdraw. Confirm rejected allocation balances remain unchanged and label pre-broadcast simulation failures accurately. Add dedicated risk-rejection demo control/evidence; not implemented yet.
2. Implement withdrawal reservations after agreeing on semantics and restoring Rust tests (design below). Current keeper only restores the buffer and can immediately redeploy a larger manual recall after claiming it. Do not promise automatic large withdrawals with current code.
3. Review the actual dependency audit output; verify wallet/network/account-change and failure flows in a browser. Correct README's outdated classic-token/trustline instructions. Consider proportional buffer policy separately, with contract enforcement and boundary tests.

## Proposed withdrawal-reservation fix (not implemented)

- Add authenticated request/cancel/claim withdrawal operations with request IDs and events. Lock requested shares; keep them in total supply until paid. Prevent the same shares being requested or withdrawn twice. Claims pay the owner only.
- Use share-denominated requests whose payout follows vault NAV, not an unfunded fixed-dollar guarantee. Define rounding with existing preview math. Compute total reserved liquidity conservatively from locked shares. Define FIFO settlement and cancellation behavior before implementation.
- Enforce allocation idle floor `max(configured buffer, reserved liquidity)` in the contract. Ordinary withdrawals must not spend liquidity reserved for others. Reservation claims consume their own reservation and burn shares atomically. Admin changes cannot bypass reservation protection.
- Keeper prioritizes reservations, recalls the shortfall, accounts for existing pending recalls, claims settled liquidity, and never redeploys reserved funds. Exclude pending value when determining further redeemable position; the mock allows one pending recall at a time. Small withdrawal shortfalls must not be stranded by the move threshold.
- UI exposes requested/settling/claimable/paid/cancelled status and current estimated payout. Failed ordinary withdrawal alone does not create a reservation.
- Required tests: unauthorized requests/cancels/claims; double request/claim; ordinary withdrawal of locked shares; FIFO and multiple users; allocation rejection at reservation boundary; other users cannot consume reserved liquidity; recall delay and early claim; pending recall counted once; claim followed by keeper tick preserves reserved idle; partial liquidity and dust; cancellation releases reservation; NAV gain/loss and rounding; paused deposits still permit exits; cap/share accounting and rollback on failed transfers. Add keeper integration coverage for the full request → recall → claim → withdraw sequence.
- A proportional policy, if selected, should define the asset denominator and rounding (e.g. ceil(20% of total assets) for allocations) and test 50/100 USDC pools, yield changes, and coexistence with reservations. It is separate from existing fixed-buffer enforcement.

## Commands

```bash
cd ~/Projects/bond-stellar
git switch meridian-demo
npm ci
npm run build:ui
npm run ui
# Open http://localhost:8080 with a Stellar wallet set to testnet.
npm audit --json

# After installing Rust via the official rustup installer:
npm run test:contracts
# For Wasm builds additionally:
rustup target add wasm32v1-none
# Install Stellar CLI separately, then:
cd contracts
stellar contract build
```

Keeper requires the configured agent signing key supplied securely through `AGENT_SECRET`; with that environment configured, run `npm run agent:once` or `npm run agent`. Never paste keys into chat or commit env files. Generated console env text is a template; the runner does not automatically load an env file. Smoke/demo scripts submit testnet transactions and use local Stellar CLI identities; run only deliberately against the intended deployment. Do not run deploy scripts merely to build or test.
