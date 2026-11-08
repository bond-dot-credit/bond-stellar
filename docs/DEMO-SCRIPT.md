# Demo video: a first-time depositor, end to end

Target length about 2:55 (the explorer visits add about 25 s over the first draft). One continuous screen recording, then a light edit (cut the waits for
transactions to confirm). Testnet only.

## Story

A new user reads the pool, connects a wallet, deposits 20 USDC, checks the transaction on
stellar.expert, watches the keeper agent deploy idle USDC, withdraws 5 USDC, then the owner shows
the Admin page. The point of the video: deposit, deploy, withdraw, and verify every step on-chain.

## Accounts

| Role | Account | Where the key is |
|---|---|---|
| Depositor (the user in the video) | `stellar-bob`, GDJBQWV7…UQ74 | Stellar CLI keystore. Import into Freighter yourself: `stellar keys secret stellar-bob` |
| Owner (Admin page) | `GD3XOPCLWPJDGCYR6U36WKWSITTQZDM7IDO7I6YB5SZJJIIUS4BRAXB5` | Your own wallet. Not in the keystore (the role was handed over) |
| Keeper agent | `stellar-agent`, GAC3Z74N…3BGG | Keystore. Run from a terminal on screen |

Pre-flight results (read from testnet): bob has 200 test USDC, 0 shares, about 10,000 XLM for fees.

## Setup before you press record

1. Freighter set to **Testnet**, with `stellar-bob` imported and selected. Your owner account added too.
2. Console running: `npm run build:ui && npm run ui`, open `http://localhost:8080`.
3. Browser window 1920×1080, zoom 100%, bookmarks bar hidden, other tabs closed.
4. Second window ready with a terminal in the repo, large font:
   `AGENT_SECRET="$(stellar keys secret stellar-agent)" npm run agent:once`
   Clear the screen first and do not show the secret.
5. The public testnet RPC is slow at times. Load the console and wait until the numbers fill in
   before recording.
6. Starting pool state (re-read before recording, it changes): total 40.5, idle 25.5, deployed 15,
   buffer 10, cap 100 USDC.

## Scenes

Numbers are approximate. The aggregator price can drift a little.

| # | Time | On screen | Voice-over (draft) | What to check |
|---|---|---|---|---|
| 1 | 0:00–0:15 | Dashboard. Pause on the top bar and stat cards. | "Pool Vault lets anyone deposit USDC on Stellar, and puts it to work in an RWA aggregator. Let's use it as a new depositor." | Total 40.5, idle 25.5, deployed 15. |
| 2 | 0:15–0:30 | Click **Connect wallet**, choose Freighter, approve. | "Connect your wallet. The console never touches your keys, and it checks you're on testnet." | Role chip shows User. Wallet shows 200 USDC. |
| 3 | 0:30–1:00 | Type **20** in Deposit, click **Deposit**, approve in Freighter. | "I'll deposit 20 USDC. The wallet shows exactly what I'm signing. Done, and my position shows up." | "Deposit — confirmed" toast. Total about 60.5, idle about 45.5, position 20. |
| 4 | 1:00–1:30 | Click the tx hash in the log. stellar.expert opens. Point at status, the `deposit` call, the events. Then open the **vault contract page** (link below) and show its balance and recent calls. Back to the console. | "Don't trust the UI, check the chain. Here's my transaction on stellar.expert: the deposit call and its events. And here's the vault contract itself, with its balance and every call made to it." | Status success on the explorer. Vault page lists the deposit. |
| 5 | 1:30–1:55 | Terminal: run the agent. Back in the console: **Venues**, then **Activity**. | "The keeper agent moves idle USDC above the buffer into the aggregator. The pool keeps 10 USDC idle so withdrawals stay instant." | Idle about 10, deployed about 50.5. New deploy event in Activity. |
| 6 | 1:55–2:25 | Back to Dashboard. Type **5** in Withdraw, click **Withdraw**, approve. Open **Transactions**, open the row, click **stellar.expert ↗** to show the withdraw on-chain. | "Withdrawing is just as direct. Shares burn, USDC comes back, and the transaction is logged here and on-chain." | Wallet USDC up by 5. Idle about 5. Row in Transactions. Withdraw tx success on the explorer. |
| 7 | 2:25–2:45 | Switch Freighter to the owner account, reconnect. Open **Admin**. Scroll once, change nothing. | "Owners get controls: pause deposits, set the cap and buffer, rotate the agent. Withdrawals are never paused." | Role chip shows Admin. |
| 8 | 2:45–2:55 | Back to Dashboard. | "That's the full loop: deposit, deploy, withdraw, verify. Testnet only." | |

## Explorer links to have ready in tabs

- Vault contract: https://stellar.expert/explorer/testnet/contract/CDVA727LYLZ3S5QSVFUSCVHHWUCQT4WE7FFJUWB5OP5GI477CFH2KREE
- Depositor account (bob): https://stellar.expert/explorer/testnet/account/GDJBQWV7YVQBSABEFW75DGSWBCNFSXFKK3662REOMP26ZESFWTO6UQ74
- Transaction pages open from the console links (hash in the log, or the Transactions row).

## Optional beat (+10 s, skip for a shorter cut)

After scene 6, try withdrawing more than the idle balance. The vault pays from idle only, so it
reverts and the console says to retry after the agent refills it. This shows the buffer rule is real.

## Do not

- Do not pause the pool during the Admin scene. It is a live testnet pool.
- Do not show secret keys or the agent command's secret on screen.

## Editing (done after you send the raw recording)

- Cut the 5–10 second waits while a transaction confirms.
- Export 1080p H.264 mp4 with `ffmpeg`.
- Voice-over is added by you on the final cut.
