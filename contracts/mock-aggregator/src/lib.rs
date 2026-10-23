#![no_std]
//! Testnet stand-in for a Soroban RWA aggregator. Holds USDC deposited by vaults,
//! issues share units at `price`, and settles redemptions after `delay` seconds.
//! The admin can move `price` to simulate yield. Not for mainnet.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, panic_with_error, token, Address, Env};

/// Price scale: 1.0 = 10_000_000 (7 decimals, same as Stellar USDC).
const ONE: i128 = 10_000_000;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Usdc,
    Price,
    Delay,
    Shares(Address),
    Pending(Address),
}

#[contracttype]
#[derive(Clone)]
pub struct Pending {
    pub amount: i128,
    pub unlock: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InsufficientPosition = 3,
    PendingExists = 4,
}

#[contract]
pub struct MockAggregator;

fn admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

fn usdc(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Usdc).unwrap()
}

fn price(env: &Env) -> i128 {
    env.storage().instance().get(&DataKey::Price).unwrap()
}

fn delay(env: &Env) -> u64 {
    env.storage().instance().get(&DataKey::Delay).unwrap()
}

fn shares_of(env: &Env, vault: &Address) -> i128 {
    env.storage().persistent().get(&DataKey::Shares(vault.clone())).unwrap_or(0)
}

fn set_shares_of(env: &Env, vault: &Address, value: i128) {
    env.storage().persistent().set(&DataKey::Shares(vault.clone()), &value);
}

fn pending_of(env: &Env, vault: &Address) -> Option<Pending> {
    env.storage().persistent().get(&DataKey::Pending(vault.clone()))
}

#[contractimpl]
impl MockAggregator {
    pub fn initialize(env: Env, admin_addr: Address, usdc_addr: Address, delay_seconds: u64) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin_addr);
        env.storage().instance().set(&DataKey::Usdc, &usdc_addr);
        env.storage().instance().set(&DataKey::Delay, &delay_seconds);
        env.storage().instance().set(&DataKey::Price, &ONE);
    }

    /// Testnet only: simulate yield by moving the share price. Admin must fund the
    /// aggregator with enough USDC to pay the yield out on redemption.
    pub fn set_price(env: Env, new_price: i128) {
        admin(&env).require_auth();
        if !env.storage().instance().has(&DataKey::Price) {
            panic_with_error!(&env, Error::NotInitialized);
        }
        env.storage().instance().set(&DataKey::Price, &new_price);
    }

    /// Credits `amount` USDC to the vault. The vault must have transferred the USDC here first.
    /// Testnet mock: a real aggregator should verify the balance it received.
    pub fn deposit(env: Env, vault: Address, amount: i128) {
        vault.require_auth();
        let minted = amount * ONE / price(&env);
        set_shares_of(&env, &vault, shares_of(&env, &vault) + minted);
    }

    /// Vault asks to redeem `amount` USDC. Shares are burned now, USDC is claimable later.
    pub fn request_redeem(env: Env, vault: Address, amount: i128) {
        vault.require_auth();
        if pending_of(&env, &vault).is_some() {
            panic_with_error!(&env, Error::PendingExists);
        }
        // Round the burn up so the vault can never pull more USDC than it gave up shares for.
        let burn = (amount * ONE + price(&env) - 1) / price(&env);
        let held = shares_of(&env, &vault);
        if burn > held {
            panic_with_error!(&env, Error::InsufficientPosition);
        }
        set_shares_of(&env, &vault, held - burn);
        let unlock = env.ledger().timestamp() + delay(&env);
        env.storage().persistent().set(&DataKey::Pending(vault), &Pending { amount, unlock });
    }

    /// Pay out a settled redemption to the vault. Returns 0 if nothing is due yet.
    pub fn claim(env: Env, vault: Address) -> i128 {
        vault.require_auth();
        let Some(pending) = pending_of(&env, &vault) else {
            return 0;
        };
        if env.ledger().timestamp() < pending.unlock {
            return 0;
        }
        token::Client::new(&env, &usdc(&env)).transfer(&env.current_contract_address(), &vault, &pending.amount);
        env.storage().persistent().remove(&DataKey::Pending(vault));
        pending.amount
    }

    /// Current value of a vault's position, including redemptions still settling.
    pub fn value_of(env: Env, vault: Address) -> i128 {
        let pending = pending_of(&env, &vault).map(|p| p.amount).unwrap_or(0);
        shares_of(&env, &vault) * price(&env) / ONE + pending
    }

    pub fn shares_of(env: Env, vault: Address) -> i128 {
        shares_of(&env, &vault)
    }

    pub fn pending(env: Env, vault: Address) -> Option<Pending> {
        pending_of(&env, &vault)
    }

    pub fn price(env: Env) -> i128 {
        price(&env)
    }
}

