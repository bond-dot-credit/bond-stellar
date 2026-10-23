use super::*;
use mock_aggregator::{MockAggregator, MockAggregatorClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Address, Env,
};

/// 1 USDC in Stellar base units (7 decimals).
const USDC: i128 = 10_000_000;
const CAP: i128 = 100 * USDC;
const BUFFER: i128 = 10 * USDC;
const DELAY: u64 = 60;

struct Ctx {
    admin: Address,
    agent: Address,
    usdc: Address,
    vault: Address,
    agg: Address,
}

fn setup(env: &Env, cap: i128, buffer: i128) -> Ctx {
    env.mock_all_auths();
    env.ledger().with_mut(|li| li.timestamp = 1_000);

    let issuer = Address::generate(env);
    let admin = Address::generate(env);
    let agent = Address::generate(env);
    let usdc = env.register_stellar_asset_contract_v2(issuer).address();
    let agg = env.register(MockAggregator, ());
    let vault = env.register(PooledVault, ());

    MockAggregatorClient::new(env, &agg).initialize(&admin, &usdc, &DELAY);
    PooledVaultClient::new(env, &vault).initialize(&admin, &agent, &usdc, &agg, &cap, &buffer);

    Ctx { admin, agent, usdc, vault, agg }
}

fn mint(env: &Env, usdc: &Address, to: &Address, amount: i128) {
    StellarAssetClient::new(env, usdc).mint(to, &amount);
}

#[test]
fn deposit_and_withdraw_roundtrip() {
    let env = Env::default();
    let c = setup(&env, CAP, BUFFER);
    let v = PooledVaultClient::new(&env, &c.vault);
    let alice = Address::generate(&env);
    mint(&env, &c.usdc, &alice, 10 * USDC);

    let shares = v.deposit(&alice, &(10 * USDC));
    assert!(shares > 0);
    assert_eq!(v.balance(&alice), shares);
    assert_eq!(v.total_assets(), 10 * USDC);

    let out = v.withdraw(&alice, &shares);
    // Virtual offset may leave at most 1 base unit of dust in the pool.
    assert!(out <= 10 * USDC && out >= 10 * USDC - 1, "out = {out}");
    assert_eq!(v.balance(&alice), 0);
}

#[test]
fn cap_is_enforced() {
    let env = Env::default();
    let c = setup(&env, CAP, BUFFER);
    let v = PooledVaultClient::new(&env, &c.vault);
    let alice = Address::generate(&env);
    mint(&env, &c.usdc, &alice, 200 * USDC);

    v.deposit(&alice, &CAP);
    assert!(v.try_deposit(&alice, &1).is_err());
}

#[test]
fn cap_can_be_raised_by_admin() {
    let env = Env::default();
    let c = setup(&env, CAP, BUFFER);
    let v = PooledVaultClient::new(&env, &c.vault);
    let alice = Address::generate(&env);
    mint(&env, &c.usdc, &alice, 200 * USDC);

    v.deposit(&alice, &CAP);
    v.set_cap(&(200 * USDC));
    assert!(v.try_deposit(&alice, &(50 * USDC)).is_ok());
}

#[test]
fn agent_deploy_keeps_buffer_idle() {
    let env = Env::default();
    let c = setup(&env, CAP, BUFFER);
    let v = PooledVaultClient::new(&env, &c.vault);
    let alice = Address::generate(&env);
    mint(&env, &c.usdc, &alice, 50 * USDC);
    v.deposit(&alice, &(50 * USDC));

    v.agent_deploy(&(40 * USDC));
    assert_eq!(v.idle(), 10 * USDC);
    // Idle is now exactly the buffer, so one more base unit would breach it.
    assert!(v.try_agent_deploy(&1).is_err());
    assert_eq!(v.total_assets(), 50 * USDC);
}

#[test]
fn agent_deploy_is_authorized_by_agent() {
    let env = Env::default();
    let c = setup(&env, CAP, BUFFER);
    let v = PooledVaultClient::new(&env, &c.vault);
    let alice = Address::generate(&env);
    mint(&env, &c.usdc, &alice, 50 * USDC);
    v.deposit(&alice, &(50 * USDC));

    v.agent_deploy(&(20 * USDC));
    let auths = env.auths();
    assert!(auths.iter().any(|(addr, _)| *addr == c.agent));
}

#[test]
fn pause_blocks_deposits_not_withdrawals() {
    let env = Env::default();
    let c = setup(&env, CAP, BUFFER);
    let v = PooledVaultClient::new(&env, &c.vault);
    let alice = Address::generate(&env);
    mint(&env, &c.usdc, &alice, 20 * USDC);
    let shares = v.deposit(&alice, &(10 * USDC));

    v.set_paused(&true);
    assert!(v.try_deposit(&alice, &USDC).is_err());
    assert!(v.try_withdraw(&alice, &shares).is_ok());
}

#[test]
fn kyc_gate_when_closed() {
    let env = Env::default();
    let c = setup(&env, CAP, BUFFER);
    let v = PooledVaultClient::new(&env, &c.vault);
    let bob = Address::generate(&env);
    mint(&env, &c.usdc, &bob, 20 * USDC);

    v.set_kyc_open(&false);
    assert!(v.try_deposit(&bob, &USDC).is_err());
    v.set_verified(&bob, &true);
    assert!(v.try_deposit(&bob, &USDC).is_ok());
}

#[test]
fn yield_from_aggregator_shows_in_total_assets() {
    let env = Env::default();
    let c = setup(&env, CAP, BUFFER);
    let v = PooledVaultClient::new(&env, &c.vault);
    let alice = Address::generate(&env);
    mint(&env, &c.usdc, &alice, 50 * USDC);
    v.deposit(&alice, &(50 * USDC));
    v.agent_deploy(&(40 * USDC));

    // Price moves 10%. The aggregator must hold the yield to pay out later.
    MockAggregatorClient::new(&env, &c.agg).set_price(&11_000_000);
    mint(&env, &c.usdc, &c.agg, 4 * USDC);

    // 10 idle + 40 deployed * 1.1 = 54
    assert_eq!(v.total_assets(), 54 * USDC);
    let out = v.preview_withdraw(&v.balance(&alice));
    assert!(out >= 54 * USDC - 1, "out = {out}");
}

#[test]
fn redemption_settles_after_delay() {
    let env = Env::default();
    let c = setup(&env, CAP, BUFFER);
    let v = PooledVaultClient::new(&env, &c.vault);
    let alice = Address::generate(&env);
    mint(&env, &c.usdc, &alice, 50 * USDC);
    v.deposit(&alice, &(50 * USDC));
    v.agent_deploy(&(40 * USDC));

    v.agent_request_redeem(&(40 * USDC));
    // Still counted in total assets while settling.
    assert_eq!(v.total_assets(), 50 * USDC);
    assert_eq!(v.agent_claim(), 0);

    env.ledger().with_mut(|li| li.timestamp = 1_000 + DELAY);
    assert_eq!(v.agent_claim(), 40 * USDC);
    assert_eq!(v.idle(), 50 * USDC);
}

#[test]
fn withdraw_reverts_when_idle_is_short() {
    let env = Env::default();
    let c = setup(&env, CAP, BUFFER);
    let v = PooledVaultClient::new(&env, &c.vault);
    let alice = Address::generate(&env);
    mint(&env, &c.usdc, &alice, 50 * USDC);
    let shares = v.deposit(&alice, &(50 * USDC));
    v.agent_deploy(&(40 * USDC));

    // Only 10 USDC idle, full exit needs 50.
    assert!(v.try_withdraw(&alice, &shares).is_err());
}

#[test]
fn first_depositor_donation_does_not_zero_out_next_depositor() {
    let env = Env::default();
    let c = setup(&env, CAP, BUFFER);
    let v = PooledVaultClient::new(&env, &c.vault);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint(&env, &c.usdc, &alice, 1);
    mint(&env, &c.usdc, &bob, 100);
    v.deposit(&alice, &1);

    // Attacker donates straight to the vault to skew the share price.
    mint(&env, &c.usdc, &c.vault, 1000);

    assert!(v.deposit(&bob, &100) > 0);
    assert!(v.balance(&bob) > 0);
}

#[test]
fn initialize_requires_admin_auth() {
    // No mock_all_auths: an attacker front-running initialization must fail.
    let env = Env::default();
    let vault = env.register(PooledVault, ());
    let client = PooledVaultClient::new(&env, &vault);
    let attacker = Address::generate(&env);
    let usdc = Address::generate(&env);
    let agg = Address::generate(&env);
    assert!(client
        .try_initialize(&attacker, &attacker, &usdc, &agg, &CAP, &BUFFER)
        .is_err());
}
