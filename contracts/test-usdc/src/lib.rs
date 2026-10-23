#![no_std]
//! Testnet-only USDC stand-in: a Soroban token (SEP-41 shape) with 7 decimals.
//! Wallets receive it without a classic trustline, and `faucet` lets anyone
//! on testnet take up to `FAUCET_MAX` per call. Not Circle USDC. Do not deploy to mainnet.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, panic_with_error, Address, Env, String};

/// 1,000 USDC in base units (7 decimals).
const FAUCET_MAX: i128 = 10_000_000_000;
const TTL_THRESHOLD: u32 = 100_000;
const TTL_EXTEND: u32 = 500_000;

#[contracttype]
enum DataKey {
    Admin,
    Balance(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidAmount = 3,
    InsufficientBalance = 4,
    FaucetLimit = 5,
}

#[contract]
pub struct TestUsdc;

fn balance_of(env: &Env, id: &Address) -> i128 {
    let key = DataKey::Balance(id.clone());
    match env.storage().persistent().get(&key) {
        Some(balance) => {
            env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
            balance
        }
        None => 0,
    }
}

fn set_balance(env: &Env, id: &Address, value: i128) {
    let key = DataKey::Balance(id.clone());
    env.storage().persistent().set(&key, &value);
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
}

fn credit(env: &Env, to: &Address, amount: i128) {
    set_balance(env, to, balance_of(env, to) + amount);
}

fn debit(env: &Env, from: &Address, amount: i128) {
    let balance = balance_of(env, from);
    if balance < amount {
        panic_with_error!(env, Error::InsufficientBalance);
    }
    set_balance(env, from, balance - amount);
}

#[contractimpl]
impl TestUsdc {
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    pub fn name(env: Env) -> String {
        String::from_str(&env, "USDC (testnet)")
    }

    pub fn symbol(env: Env) -> String {
        String::from_str(&env, "USDC")
    }

    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        balance_of(&env, &id)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        debit(&env, &from, amount);
        credit(&env, &to, amount);
    }

    /// Admin only: issue tokens to any address.
    pub fn mint(env: Env, to: Address, amount: i128) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        credit(&env, &to, amount);
    }

    /// Testnet faucet: anyone can take up to 1,000 USDC per call for themselves.
    pub fn faucet(env: Env, to: Address, amount: i128) {
        to.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if amount > FAUCET_MAX {
            panic_with_error!(&env, Error::FaucetLimit);
        }
        credit(&env, &to, amount);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    #[test]
    fn mint_faucet_and_transfer() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let id = env.register(TestUsdc, ());
        let client = TestUsdcClient::new(&env, &id);

        client.initialize(&admin);
        client.mint(&alice, &1_000);
        client.faucet(&alice, &500);
        assert_eq!(client.balance(&alice), 1_500);

        client.transfer(&alice, &bob, &700);
        assert_eq!(client.balance(&alice), 800);
        assert_eq!(client.balance(&bob), 700);
        assert_eq!(client.decimals(), 7);
    }

    #[test]
    fn faucet_caps_each_call() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let alice = Address::generate(&env);
        let id = env.register(TestUsdc, ());
        let client = TestUsdcClient::new(&env, &id);
        client.initialize(&admin);

        assert!(client.try_faucet(&alice, &(FAUCET_MAX + 1)).is_err());
        assert!(client.try_transfer(&alice, &admin, &1).is_err());
    }
}
