#![no_std]
//! Pooled USDC vault. Anyone can deposit (while KYC is open) and receives shares.
//! The agent moves idle USDC into an aggregator and back out. Withdrawals are paid
//! from idle USDC only, and are never paused.

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, panic_with_error, token,
    Address, Env,
};

// ponytail: shares are internal balances, not a SEP-41 token. Wallets can't transfer them yet. Upgrade path: implement the SEP-41 interface over the same balances.
/// Virtual offset for share math. Makes the first-depositor inflation attack uneconomic.
const VIRTUAL_SHARES: i128 = 1_000_000;
const VIRTUAL_ASSETS: i128 = 1;
/// Persistent/instance TTL bump, in ledgers (~5 days at 5s per ledger, bumped on each write).
const TTL_THRESHOLD: u32 = 100_000;
const TTL_EXTEND: u32 = 500_000;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Agent,
    Usdc,
    Aggregator,
    Cap,
    Buffer,
    Paused,
    KycOpen,
    TotalShares,
    Shares(Address),
    Verified(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    ZeroAmount = 3,
    ZeroShares = 4,
    Paused = 5,
    NotVerified = 6,
    CapExceeded = 7,
    InsufficientShares = 8,
    InsufficientIdle = 9,
    BufferBreached = 10,
}

// ponytail: the vault calls the aggregator directly, with no separate adapter contract. Upgrade path: an adapter when a second aggregator is added.
/// Client for the aggregator the vault deploys into. The mock lives in `mock-aggregator`;
/// a real Soroban aggregator only needs to expose these four functions to slot in.
#[contractclient(name = "AggregatorClient")]
pub trait AggregatorInterface {
    fn deposit(env: Env, vault: Address, amount: i128);
    fn request_redeem(env: Env, vault: Address, amount: i128);
    fn claim(env: Env, vault: Address) -> i128;
    fn value_of(env: Env, vault: Address) -> i128;
}

#[contract]
pub struct PooledVault;

fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
}

fn require_init(env: &Env) {
    if !env.storage().instance().has(&DataKey::Admin) {
        panic_with_error!(env, Error::NotInitialized);
    }
}

fn admin(env: &Env) -> Address {
    require_init(env);
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

fn agent(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Agent).unwrap()
}

fn usdc(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Usdc).unwrap()
}

fn aggregator(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Aggregator).unwrap()
}

fn cap(env: &Env) -> i128 {
    env.storage().instance().get(&DataKey::Cap).unwrap()
}

fn buffer(env: &Env) -> i128 {
    env.storage().instance().get(&DataKey::Buffer).unwrap()
}

fn is_paused(env: &Env) -> bool {
    env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
}

fn kyc_open(env: &Env) -> bool {
    env.storage().instance().get(&DataKey::KycOpen).unwrap_or(true)
}

fn total_shares(env: &Env) -> i128 {
    env.storage().instance().get(&DataKey::TotalShares).unwrap_or(0)
}

fn set_total_shares(env: &Env, value: i128) {
    env.storage().instance().set(&DataKey::TotalShares, &value);
}

fn shares_of(env: &Env, user: &Address) -> i128 {
    env.storage().persistent().get(&DataKey::Shares(user.clone())).unwrap_or(0)
}

fn set_shares_of(env: &Env, user: &Address, value: i128) {
    let key = DataKey::Shares(user.clone());
    env.storage().persistent().set(&key, &value);
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
}

fn is_verified(env: &Env, user: &Address) -> bool {
    env.storage().persistent().get(&DataKey::Verified(user.clone())).unwrap_or(false)
}

/// Total assets = idle USDC held here + value of the aggregator position.
fn total_assets(env: &Env) -> i128 {
    let vault = env.current_contract_address();
    let idle = token::Client::new(env, &usdc(env)).balance(&vault);
    let deployed = AggregatorClient::new(env, &aggregator(env)).value_of(&vault);
    idle + deployed
}

fn idle_usdc(env: &Env) -> i128 {
    token::Client::new(env, &usdc(env)).balance(&env.current_contract_address())
}

#[contractimpl]
impl PooledVault {
    pub fn initialize(
        env: Env,
        admin_addr: Address,
        agent_addr: Address,
        usdc_addr: Address,
        aggregator_addr: Address,
        cap_amount: i128,
        buffer_amount: i128,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin_addr);
        env.storage().instance().set(&DataKey::Agent, &agent_addr);
        env.storage().instance().set(&DataKey::Usdc, &usdc_addr);
        env.storage().instance().set(&DataKey::Aggregator, &aggregator_addr);
        env.storage().instance().set(&DataKey::Cap, &cap_amount);
        env.storage().instance().set(&DataKey::Buffer, &buffer_amount);
        env.storage().instance().set(&DataKey::KycOpen, &true);
        bump_instance(&env);
    }

    // ----- admin (pause / config / kyc) -----

    pub fn set_paused(env: Env, paused: bool) {
        admin(&env).require_auth();
        env.storage().instance().set(&DataKey::Paused, &paused);
    }

    pub fn set_cap(env: Env, cap_amount: i128) {
        admin(&env).require_auth();
        env.storage().instance().set(&DataKey::Cap, &cap_amount);
    }

    pub fn set_buffer(env: Env, buffer_amount: i128) {
        admin(&env).require_auth();
        env.storage().instance().set(&DataKey::Buffer, &buffer_amount);
    }

    pub fn set_agent(env: Env, agent_addr: Address) {
        admin(&env).require_auth();
        env.storage().instance().set(&DataKey::Agent, &agent_addr);
    }

    // ponytail: simulated KYC is a flag, not a KycProvider trait. Upgrade path: a provider contract the vault calls from `deposit`.
    /// Simulated KYC. `true` = anyone may deposit (current testnet mode).
    /// `false` = only addresses marked with `set_verified` may deposit.
    pub fn set_kyc_open(env: Env, open: bool) {
        admin(&env).require_auth();
        env.storage().instance().set(&DataKey::KycOpen, &open);
    }

    pub fn set_verified(env: Env, user: Address, verified: bool) {
        admin(&env).require_auth();
        let key = DataKey::Verified(user);
        env.storage().persistent().set(&key, &verified);
        env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
    }

    // ----- depositors -----

    /// Deposit `amount` base units of USDC and receive shares. Returns shares minted.
    pub fn deposit(env: Env, user: Address, amount: i128) -> i128 {
        user.require_auth();
        bump_instance(&env);
        if amount <= 0 {
            panic_with_error!(&env, Error::ZeroAmount);
        }
        if is_paused(&env) {
            panic_with_error!(&env, Error::Paused);
        }
        if !kyc_open(&env) && !is_verified(&env, &user) {
            panic_with_error!(&env, Error::NotVerified);
        }

        let assets = total_assets(&env);
        if assets + amount > cap(&env) {
            panic_with_error!(&env, Error::CapExceeded);
        }

        let shares = amount * (total_shares(&env) + VIRTUAL_SHARES) / (assets + VIRTUAL_ASSETS);
        if shares == 0 {
            panic_with_error!(&env, Error::ZeroShares);
        }

        token::Client::new(&env, &usdc(&env)).transfer(&user, &env.current_contract_address(), &amount);
        set_total_shares(&env, total_shares(&env) + shares);
        set_shares_of(&env, &user, shares_of(&env, &user) + shares);
        shares
    }

    /// Burn `shares` and receive USDC from idle balance. Never paused.
    pub fn withdraw(env: Env, user: Address, shares: i128) -> i128 {
        user.require_auth();
        bump_instance(&env);
        if shares <= 0 {
            panic_with_error!(&env, Error::ZeroAmount);
        }
        if shares > shares_of(&env, &user) {
            panic_with_error!(&env, Error::InsufficientShares);
        }

        let assets = total_assets(&env);
        let amount = shares * (assets + VIRTUAL_ASSETS) / (total_shares(&env) + VIRTUAL_SHARES);
        if amount > idle_usdc(&env) {
            panic_with_error!(&env, Error::InsufficientIdle);
        }

        set_total_shares(&env, total_shares(&env) - shares);
        set_shares_of(&env, &user, shares_of(&env, &user) - shares);
        token::Client::new(&env, &usdc(&env)).transfer(&env.current_contract_address(), &user, &amount);
        amount
    }

    // ----- agent -----

    /// Move `amount` of idle USDC into the aggregator. Keeps `buffer` idle for withdrawals.
    pub fn agent_deploy(env: Env, amount: i128) {
        agent(&env).require_auth();
        bump_instance(&env);
        if amount <= 0 {
            panic_with_error!(&env, Error::ZeroAmount);
        }
        if idle_usdc(&env) - amount < buffer(&env) {
            panic_with_error!(&env, Error::BufferBreached);
        }
        // Send first, then notify. The aggregator can't pull on our behalf: a nested
        // token transfer from this contract would need an explicit sub-authorization.
        let vault = env.current_contract_address();
        token::Client::new(&env, &usdc(&env)).transfer(&vault, &aggregator(&env), &amount);
        AggregatorClient::new(&env, &aggregator(&env)).deposit(&vault, &amount);
    }

    /// Ask the aggregator to redeem `amount` of USDC. Pays out after its redemption delay.
    pub fn agent_request_redeem(env: Env, amount: i128) {
        agent(&env).require_auth();
        bump_instance(&env);
        if amount <= 0 {
            panic_with_error!(&env, Error::ZeroAmount);
        }
        AggregatorClient::new(&env, &aggregator(&env)).request_redeem(&env.current_contract_address(), &amount);
    }

    /// Claim any redemption that has finished settling. Returns the amount received.
    pub fn agent_claim(env: Env) -> i128 {
        agent(&env).require_auth();
        bump_instance(&env);
        AggregatorClient::new(&env, &aggregator(&env)).claim(&env.current_contract_address())
    }

    // ----- views -----

    pub fn total_assets(env: Env) -> i128 {
        total_assets(&env)
    }

    pub fn idle(env: Env) -> i128 {
        idle_usdc(&env)
    }

    pub fn total_supply(env: Env) -> i128 {
        total_shares(&env)
    }

    pub fn balance(env: Env, user: Address) -> i128 {
        shares_of(&env, &user)
    }

    pub fn cap(env: Env) -> i128 {
        cap(&env)
    }

    pub fn buffer(env: Env) -> i128 {
        buffer(&env)
    }

    pub fn paused(env: Env) -> bool {
        is_paused(&env)
    }

    pub fn kyc_open(env: Env) -> bool {
        kyc_open(&env)
    }

    pub fn is_verified(env: Env, user: Address) -> bool {
        is_verified(&env, &user)
    }

    /// Shares a user would receive for depositing `amount` right now (ignores cap/KYC/pause).
    pub fn preview_deposit(env: Env, amount: i128) -> i128 {
        amount * (total_shares(&env) + VIRTUAL_SHARES) / (total_assets(&env) + VIRTUAL_ASSETS)
    }

    /// USDC a user would receive for burning `shares` right now.
    pub fn preview_withdraw(env: Env, shares: i128) -> i128 {
        shares * (total_assets(&env) + VIRTUAL_ASSETS) / (total_shares(&env) + VIRTUAL_SHARES)
    }

    pub fn admin(env: Env) -> Address {
        admin(&env)
    }

    pub fn agent(env: Env) -> Address {
        agent(&env)
    }

    pub fn usdc(env: Env) -> Address {
        usdc(&env)
    }

    pub fn aggregator(env: Env) -> Address {
        aggregator(&env)
    }
}

#[cfg(test)]
mod test;
