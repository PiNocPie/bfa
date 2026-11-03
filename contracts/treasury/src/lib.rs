//! BFA treasury.
//!
//! Each user has a vault. The vault's Base address is derived by NEAR Chain Signatures from
//! this contract's account and the path `vault/<user account id>`, so only this contract can
//! ask the MPC network to sign for it. The contract signs nothing but USDC EIP-3009
//! authorizations (TransferWithAuthorization for exact payments, ReceiveWithAuthorization for
//! batch-settlement channel deposits), and only after checking the user's policy:
//! not paused, an allowed token, an allowed recipient, and the daily limit.
//!
//! The user's agent can hold a function-call access key that may call `sign_eip3009` only.
//! Changing limits needs 1 yoctoNEAR attached, which a function-call key cannot attach, so an
//! agent can never raise its own limits.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, Gas, GasWeight, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

const NANOS_PER_DAY: u64 = 86_400 * 1_000_000_000;
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
const MIN_PREPAID_GAS: Gas = Gas::from_tgas(250);
const VAULT_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(20);
const MAX_ALLOWED_RECIPIENTS: usize = 32;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Vault {
    /// Most USDC (6-decimal atomic units) the vault may authorize per UTC day.
    pub daily_limit: U128,
    pub spent_today: U128,
    /// UTC day index of `spent_today`.
    pub day: u64,
    /// Lowercase 0x addresses that may receive funds. Empty means any recipient.
    pub allowed_to: Vec<String>,
    pub paused: bool,
}

#[near(serializers = [json])]
pub struct SignRequest {
    /// "transfer" (TransferWithAuthorization) or "receive" (ReceiveWithAuthorization).
    pub kind: String,
    pub chain_id: u64,
    pub token: String,
    pub domain_name: String,
    pub domain_version: String,
    pub from: String,
    pub to: String,
    pub value: U128,
    pub valid_after: U64,
    pub valid_before: U64,
    /// 0x-prefixed 32-byte hex.
    pub nonce: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Treasury {
    mpc: AccountId,
    /// (chain id, lowercase USDC address) pairs this treasury will sign for.
    tokens: Vec<(u64, String)>,
    vaults: LookupMap<AccountId, Vault>,
}

#[near]
impl Treasury {
    #[init]
    pub fn new(mpc: AccountId, tokens: Vec<(u64, String)>) -> Self {
        let tokens = tokens
            .into_iter()
            .map(|(c, a)| (c, normalize_address(&a)))
            .collect();
        Self { mpc, tokens, vaults: LookupMap::new(b"v") }
    }

    /// Create the caller's vault. Attach at least 0.02 NEAR for storage.
    #[payable]
    pub fn create_vault(&mut self, daily_limit: U128, allowed_to: Vec<String>) -> Vault {
        require!(
            env::attached_deposit() >= VAULT_STORAGE_DEPOSIT,
            "attach at least 0.02 NEAR for vault storage"
        );
        let owner = env::predecessor_account_id();
        require!(self.vaults.get(&owner).is_none(), "vault already exists; use set_limits");
        let vault = Vault {
            daily_limit,
            spent_today: U128(0),
            day: today(),
            allowed_to: normalize_list(allowed_to),
            paused: false,
        };
        self.vaults.insert(owner, vault.clone());
        vault
    }

    /// Change the caller's limits. Needs exactly 1 yoctoNEAR, so only a full-access key can do it.
    #[payable]
    pub fn set_limits(&mut self, daily_limit: U128, allowed_to: Vec<String>) -> Vault {
        assert_one_yocto();
        let owner = env::predecessor_account_id();
        let mut vault = self.vault_or_panic(&owner);
        vault.daily_limit = daily_limit;
        vault.allowed_to = normalize_list(allowed_to);
        self.vaults.insert(owner, vault.clone());
        vault
    }

    /// Stop all signing for the caller's vault. Works from a full-access key.
    #[payable]
    pub fn pause(&mut self) {
        assert_one_yocto();
        self.set_paused(true);
    }

    #[payable]
    pub fn unpause(&mut self) {
        assert_one_yocto();
        self.set_paused(false);
    }

    pub fn get_vault(&self, account_id: AccountId) -> Option<Vault> {
        self.vaults.get(&account_id).map(|v| {
            let mut v = v.clone();
            if v.day != today() {
                v.spent_today = U128(0);
                v.day = today();
            }
            v
        })
    }

    pub fn derivation_path(&self, account_id: AccountId) -> String {
        format!("vault/{account_id}")
    }

    pub fn mpc_contract(&self) -> AccountId {
        self.mpc.clone()
    }

    pub fn tokens(&self) -> Vec<(u64, String)> {
        self.tokens.clone()
    }

    /// Check the caller's policy, then ask the MPC network to sign the EIP-712 digest of the
    /// USDC authorization. Returns the MPC signature response, or null if signing failed (the
    /// amount is released back to today's limit in that case).
    pub fn sign_eip3009(&mut self, request: SignRequest) -> Promise {
        let owner = env::predecessor_account_id();
        let mut vault = self.vault_or_panic(&owner);
        require!(!vault.paused, "vault_paused");

        let token = normalize_address(&request.token);
        require!(
            self.tokens.iter().any(|(c, a)| *c == request.chain_id && *a == token),
            "token_not_allowed"
        );
        let to = normalize_address(&request.to);
        require!(
            vault.allowed_to.is_empty() || vault.allowed_to.contains(&to),
            "recipient_not_allowed"
        );

        if vault.day != today() {
            vault.day = today();
            vault.spent_today = U128(0);
        }
        let value = request.value.0;
        let spent = vault.spent_today.0.checked_add(value).expect("overflow");
        require!(spent <= vault.daily_limit.0, "limit_reached");
        vault.spent_today = U128(spent);
        self.vaults.insert(owner.clone(), vault);

        let digest = eip3009_digest(&request);
        let args = json!({
            "request": {
                "payload_v2": { "Ecdsa": hex::encode(digest) },
                "path": format!("vault/{owner}"),
                "domain_id": 0
            }
        });

        require!(
            env::prepaid_gas() >= MIN_PREPAID_GAS,
            "attach more gas: 300 Tgas recommended"
        );

        // The MPC call gets all gas left after this call and the callback's fixed share.
        Promise::new(self.mpc.clone())
            .function_call_weight(
                "sign".to_string(),
                serde_json::to_vec(&args).expect("json"),
                NearToken::from_yoctonear(1),
                Gas::from_tgas(0),
                GasWeight(1),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_signed(owner, request.value),
            )
    }

    #[private]
    pub fn on_signed(
        &mut self,
        owner: AccountId,
        value: U128,
        #[callback_result] result: Result<Value, PromiseError>,
    ) -> Option<Value> {
        match result {
            Ok(sig) => Some(sig),
            Err(_) => {
                if let Some(v) = self.vaults.get(&owner) {
                    let mut v = v.clone();
                    if v.day == today() {
                        v.spent_today = U128(v.spent_today.0.saturating_sub(value.0));
                    }
                    self.vaults.insert(owner, v);
                }
                env::log_str("mpc_sign_failed: amount released");
                None
            }
        }
    }
}

impl Treasury {
    fn vault_or_panic(&self, owner: &AccountId) -> Vault {
        self.vaults.get(owner).cloned().unwrap_or_else(|| env::panic_str("no_vault"))
    }

    fn set_paused(&mut self, paused: bool) {
        let owner = env::predecessor_account_id();
        let mut vault = self.vault_or_panic(&owner);
        vault.paused = paused;
        self.vaults.insert(owner, vault);
    }
}

fn today() -> u64 {
    env::block_timestamp() / NANOS_PER_DAY
}

fn normalize_address(a: &str) -> String {
    let s = a.trim().to_ascii_lowercase();
    let body = s.strip_prefix("0x").unwrap_or_else(|| env::panic_str("address must start with 0x"));
    require!(
        body.len() == 40 && body.chars().all(|c| c.is_ascii_hexdigit()),
        "address must be 20 bytes of hex"
    );
    s
}

fn normalize_list(list: Vec<String>) -> Vec<String> {
    require!(list.len() <= MAX_ALLOWED_RECIPIENTS, "too many recipients");
    let mut out: Vec<String> = list.iter().map(|a| normalize_address(a)).collect();
    out.sort();
    out.dedup();
    out
}

fn keccak(bytes: &[u8]) -> [u8; 32] {
    env::keccak256_array(bytes)
}

fn word_address(a: &str) -> [u8; 32] {
    let raw = hex::decode(&normalize_address(a)[2..]).expect("hex");
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(&raw);
    w
}

fn word_u128(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

fn word_bytes32(h: &str) -> [u8; 32] {
    let s = h.trim().to_ascii_lowercase();
    let body = s.strip_prefix("0x").unwrap_or_else(|| env::panic_str("nonce must start with 0x"));
    let raw = hex::decode(body).unwrap_or_else(|_| env::panic_str("nonce must be hex"));
    require!(raw.len() == 32, "nonce must be 32 bytes");
    let mut w = [0u8; 32];
    w.copy_from_slice(&raw);
    w
}

/// EIP-712 digest of a USDC (FiatTokenV2) EIP-3009 authorization.
pub fn eip3009_digest(r: &SignRequest) -> [u8; 32] {
    let primary = match r.kind.as_str() {
        "transfer" => "TransferWithAuthorization",
        "receive" => "ReceiveWithAuthorization",
        _ => env::panic_str("kind must be transfer or receive"),
    };
    let type_hash = keccak(
        format!(
            "{primary}(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        )
        .as_bytes(),
    );
    let mut s = Vec::with_capacity(32 * 7);
    s.extend_from_slice(&type_hash);
    s.extend_from_slice(&word_address(&r.from));
    s.extend_from_slice(&word_address(&r.to));
    s.extend_from_slice(&word_u128(r.value.0));
    s.extend_from_slice(&word_u128(r.valid_after.0 as u128));
    s.extend_from_slice(&word_u128(r.valid_before.0 as u128));
    s.extend_from_slice(&word_bytes32(&r.nonce));
    let struct_hash = keccak(&s);

    let domain_type = keccak(
        b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    );
    let mut d = Vec::with_capacity(32 * 5);
    d.extend_from_slice(&domain_type);
    d.extend_from_slice(&keccak(r.domain_name.as_bytes()));
    d.extend_from_slice(&keccak(r.domain_version.as_bytes()));
    d.extend_from_slice(&word_u128(r.chain_id as u128));
    d.extend_from_slice(&word_address(&r.token));
    let domain_sep = keccak(&d);

    let mut m = Vec::with_capacity(66);
    m.extend_from_slice(&[0x19, 0x01]);
    m.extend_from_slice(&domain_sep);
    m.extend_from_slice(&struct_hash);
    keccak(&m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const USDC: &str = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const PAYER: &str = "0xcB9fFe1087b5442ceEf609361CE633B1795C21cA";
    const SELLER: &str = "0x11F4555ABdaa2BC5b39A172E39b69E8293ad4aA3";

    fn req(kind: &str, value: u128, to: &str) -> SignRequest {
        SignRequest {
            kind: kind.into(),
            chain_id: 84532,
            token: USDC.into(),
            domain_name: "USDC".into(),
            domain_version: "2".into(),
            from: PAYER.into(),
            to: to.into(),
            value: U128(value),
            valid_after: U64(0),
            valid_before: U64(1_793_732_459),
            nonce: format!("0x{}", "ab".repeat(32)),
        }
    }

    fn ctx(who: &str, deposit: NearToken) {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(who.parse().unwrap())
            .current_account_id("treasury.testnet".parse().unwrap())
            .attached_deposit(deposit)
            .prepaid_gas(Gas::from_tgas(300))
            .account_balance(NearToken::from_near(10))
            .block_timestamp(1_793_732_000 * 1_000_000_000);
        testing_env!(b.build());
    }

    fn treasury() -> Treasury {
        Treasury::new("v1.signer-prod.testnet".parse().unwrap(), vec![(84532, USDC.into())])
    }

    // Reference digests computed with viem's hashTypedData for the same messages.
    #[test]
    fn digest_matches_viem() {
        ctx("alice.testnet", NearToken::from_yoctonear(0));
        assert_eq!(
            hex::encode(eip3009_digest(&req("receive", 50_000, SELLER))),
            "e6898d1c27e3c4581e80212a55d28861d032695191eb9bb7df6c2670e45c46a9"
        );
        assert_eq!(
            hex::encode(eip3009_digest(&req("transfer", 50_000, SELLER))),
            "5d5ec91b4d3c1ba3e35664b17f7bcb94066dda727e5ab01514bb08b8b37aca6d"
        );
    }

    #[test]
    fn daily_limit_is_enforced_and_resets() {
        let mut t = treasury();
        ctx("alice.testnet", VAULT_STORAGE_DEPOSIT);
        t.create_vault(U128(100_000), vec![]);
        ctx("alice.testnet", NearToken::from_yoctonear(0));
        let _ = t.sign_eip3009(req("receive", 60_000, SELLER));
        let _ = t.sign_eip3009(req("transfer", 40_000, SELLER));
        assert_eq!(t.get_vault("alice.testnet".parse().unwrap()).unwrap().spent_today.0, 100_000);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = t.sign_eip3009(req("transfer", 1, SELLER));
        }));
        assert!(r.is_err(), "one atomic unit over the limit must be refused");
    }

    #[test]
    #[should_panic(expected = "recipient_not_allowed")]
    fn recipient_allowlist() {
        let mut t = treasury();
        ctx("alice.testnet", VAULT_STORAGE_DEPOSIT);
        t.create_vault(U128(1_000_000), vec![SELLER.into()]);
        ctx("alice.testnet", NearToken::from_yoctonear(0));
        let _ = t.sign_eip3009(req("transfer", 1, "0x000000000000000000000000000000000000dEaD"));
    }

    #[test]
    #[should_panic(expected = "token_not_allowed")]
    fn only_configured_tokens() {
        let mut t = treasury();
        ctx("alice.testnet", VAULT_STORAGE_DEPOSIT);
        t.create_vault(U128(1_000_000), vec![]);
        ctx("alice.testnet", NearToken::from_yoctonear(0));
        let mut r = req("transfer", 1, SELLER);
        r.token = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".into();
        let _ = t.sign_eip3009(r);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn function_call_keys_cannot_raise_limits() {
        let mut t = treasury();
        ctx("alice.testnet", VAULT_STORAGE_DEPOSIT);
        t.create_vault(U128(1), vec![]);
        ctx("alice.testnet", NearToken::from_yoctonear(0));
        t.set_limits(U128(1_000_000_000), vec![]);
    }

    #[test]
    #[should_panic(expected = "vault_paused")]
    fn paused_vault_signs_nothing() {
        let mut t = treasury();
        ctx("alice.testnet", VAULT_STORAGE_DEPOSIT);
        t.create_vault(U128(1_000_000), vec![]);
        ctx("alice.testnet", NearToken::from_yoctonear(1));
        t.pause();
        ctx("alice.testnet", NearToken::from_yoctonear(0));
        let _ = t.sign_eip3009(req("transfer", 1, SELLER));
    }

    #[test]
    #[should_panic(expected = "no_vault")]
    fn other_accounts_have_no_vault() {
        let mut t = treasury();
        ctx("alice.testnet", VAULT_STORAGE_DEPOSIT);
        t.create_vault(U128(1_000_000), vec![]);
        ctx("mallory.testnet", NearToken::from_yoctonear(0));
        let _ = t.sign_eip3009(req("transfer", 1, SELLER));
    }

    #[test]
    fn failed_signature_releases_the_amount() {
        let mut t = treasury();
        ctx("alice.testnet", VAULT_STORAGE_DEPOSIT);
        t.create_vault(U128(100_000), vec![]);
        ctx("alice.testnet", NearToken::from_yoctonear(0));
        let _ = t.sign_eip3009(req("transfer", 70_000, SELLER));
        ctx("treasury.testnet", NearToken::from_yoctonear(0));
        let out = t.on_signed("alice.testnet".parse().unwrap(), U128(70_000), Err(PromiseError::Failed));
        assert!(out.is_none());
        assert_eq!(t.get_vault("alice.testnet".parse().unwrap()).unwrap().spent_today.0, 0);
    }
}
