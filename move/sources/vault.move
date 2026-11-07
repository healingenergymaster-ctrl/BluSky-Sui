// move/sources/vault.move
// BluSky-Sui Non-Custodial Concentrated Liquidity Vault

module blusky_vault::vault {
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::event;

    // --- Events ---
    public struct DepositEvent has copy, drop {
        vault_id: ID,
        depositor: address,
        shares_minted: u64,
        amount_a: u64,
        amount_b: u64,
    }

    public struct WithdrawEvent has copy, drop {
        vault_id: ID,
        withdrawer: address,
        shares_burned: u64,
        amount_a_returned: u64,
        amount_b_returned: u64,
    }

    public struct RebalanceEvent has copy, drop {
        vault_id: ID,
        operator: address,
        old_lower_tick: u32,
        old_upper_tick: u32,
        new_lower_tick: u32,
        new_upper_tick: u32,
        timestamp_ms: u64,
    }

    public struct FeeHarvestedEvent has copy, drop {
        vault_id: ID,
        gross_fee_a: u64,
        gross_fee_b: u64,
        performance_fee_a: u64,
        performance_fee_b: u64,
        compounded_amount_a: u64,
        compounded_amount_b: u64,
    }

    public struct PerformanceFeePaidEvent has copy, drop {
        vault_id: ID,
        treasury: address,
        fee_a: u64,
        fee_b: u64,
    }

    public struct OperatorUpdatedEvent has copy, drop {
        vault_id: ID,
        new_operator: address,
    }

    // --- Error Codes ---
    const EZeroDeposit: u64 = 1;
    const EZeroShares: u64 = 2;
    const EInvalidShareVault: u64 = 3;
    const EFeeRateTooHigh: u64 = 4;
    const EInvalidTicks: u64 = 5;
    const EInsufficientShares: u64 = 6;

    // --- Constants ---
    const MAX_FEE_BPS: u64 = 2500; // Maximum allowed performance fee: 25.0%
    const DEFAULT_FEE_BPS: u64 = 1000; // 10.0% performance fee on trading profits

    /// Core Shared Vault Object
    public struct Vault<phantom CoinA, phantom CoinB> has key {
        id: UID,
        balance_a: Balance<CoinA>,
        balance_b: Balance<CoinB>,
        total_shares: u64,
        fee_rate_bps: u64,
        fee_treasury: address,
        clmm_position_id: option::Option<ID>,
        current_lower_tick: u32,
        current_upper_tick: u32,
    }

    /// Transferable Vault LP Share Object
    public struct VaultShare<phantom CoinA, phantom CoinB> has key, store {
        id: UID,
        vault_id: ID,
        shares: u64,
    }

    /// Admin Capability (Protocol Owner)
    public struct VaultAdminCap has key, store {
        id: UID,
        vault_id: ID,
    }

    /// Operator Capability (Delegated to Automated Bot Daemon)
    public struct OperatorCap has key, store {
        id: UID,
        vault_id: ID,
    }

    // --- Initializer & Factory ---

    /// Creates a new public non-custodial liquidity vault for CoinA/CoinB
    public fun create_vault<CoinA, CoinB>(
        fee_rate_bps: u64,
        fee_treasury: address,
        ctx: &mut TxContext
    ) {
        assert!(fee_rate_bps <= MAX_FEE_BPS, EFeeRateTooHigh);

        let vault_uid = object::new(ctx);
        let vault_id = object::uid_to_inner(&vault_uid);

        let vault = Vault<CoinA, CoinB> {
            id: vault_uid,
            balance_a: balance::zero<CoinA>(),
            balance_b: balance::zero<CoinB>(),
            total_shares: 0,
            fee_rate_bps,
            fee_treasury,
            clmm_position_id: option::none(),
            current_lower_tick: 0,
            current_upper_tick: 0,
        };

        let admin_cap = VaultAdminCap {
            id: object::new(ctx),
            vault_id,
        };

        let operator_cap = OperatorCap {
            id: object::new(ctx),
            vault_id,
        };

        let sender = tx_context::sender(ctx);
        transfer::transfer(admin_cap, sender);
        transfer::transfer(operator_cap, sender);
        transfer::share_object(vault);
    }

    // --- User Actions: Deposit & Withdraw ---

    /// Deposits CoinA and CoinB into the vault, minting transferable VaultShares
    public fun deposit<CoinA, CoinB>(
        vault: &mut Vault<CoinA, CoinB>,
        coin_a: Coin<CoinA>,
        coin_b: Coin<CoinB>,
        ctx: &mut TxContext
    ): VaultShare<CoinA, CoinB> {
        let amount_a = coin::value(&coin_a);
        let amount_b = coin::value(&coin_b);
        assert!(amount_a > 0 || amount_b > 0, EZeroDeposit);

        let cur_val_a = balance::value(&vault.balance_a);
        let cur_val_b = balance::value(&vault.balance_b);

        let shares_to_mint: u64;

        if (vault.total_shares == 0) {
            // Initial deposit: geometric mean or simple sum
            shares_to_mint = amount_a + amount_b;
        } else {
            // Proportional share issuance based on current total assets
            let share_a = if (cur_val_a > 0) { (amount_a * vault.total_shares) / cur_val_a } else { 0 };
            let share_b = if (cur_val_b > 0) { (amount_b * vault.total_shares) / cur_val_b } else { 0 };

            if (share_a > 0 && share_b > 0) {
                shares_to_mint = if (share_a < share_b) { share_a } else { share_b };
            } else if (share_a > 0) {
                shares_to_mint = share_a;
            } else {
                shares_to_mint = share_b;
            };
        };

        assert!(shares_to_mint > 0, EZeroShares);

        balance::join(&mut vault.balance_a, coin::into_balance(coin_a));
        balance::join(&mut vault.balance_b, coin::into_balance(coin_b));
        vault.total_shares = vault.total_shares + shares_to_mint;

        let vault_id = object::uid_to_inner(&vault.id);
        let depositor = tx_context::sender(ctx);

        event::emit(DepositEvent {
            vault_id,
            depositor,
            shares_minted: shares_to_mint,
            amount_a,
            amount_b,
        });

        VaultShare<CoinA, CoinB> {
            id: object::new(ctx),
            vault_id,
            shares: shares_to_mint,
        }
    }

    /// Redeems VaultShares for the underlying CoinA and CoinB pro-rata
    public fun withdraw<CoinA, CoinB>(
        vault: &mut Vault<CoinA, CoinB>,
        share: VaultShare<CoinA, CoinB>,
        ctx: &mut TxContext
    ): (Coin<CoinA>, Coin<CoinB>) {
        let VaultShare { id, vault_id, shares } = share;
        object::delete(id);

        assert!(vault_id == object::uid_to_inner(&vault.id), EInvalidShareVault);
        assert!(shares > 0, EZeroShares);

        let total_val_a = balance::value(&vault.balance_a);
        let total_val_b = balance::value(&vault.balance_b);

        let amount_a_out = (shares * total_val_a) / vault.total_shares;
        let amount_b_out = (shares * total_val_b) / vault.total_shares;

        vault.total_shares = vault.total_shares - shares;

        let coin_a = coin::take(&mut vault.balance_a, amount_a_out, ctx);
        let coin_b = coin::take(&mut vault.balance_b, amount_b_out, ctx);

        let withdrawer = tx_context::sender(ctx);
        event::emit(WithdrawEvent {
            vault_id,
            withdrawer,
            shares_burned: shares,
            amount_a_returned: amount_a_out,
            amount_b_returned: amount_b_out,
        });

        (coin_a, coin_b)
    }

    /// Splits an existing VaultShare into two separate VaultShare objects.
    /// Allows users to withdraw any arbitrary partial amount without redeeming their full position.
    public fun split_share<CoinA, CoinB>(
        share: &mut VaultShare<CoinA, CoinB>,
        split_shares: u64,
        ctx: &mut TxContext
    ): VaultShare<CoinA, CoinB> {
        assert!(split_shares > 0, EZeroShares);
        assert!(share.shares > split_shares, EInsufficientShares);

        share.shares = share.shares - split_shares;

        VaultShare<CoinA, CoinB> {
            id: object::new(ctx),
            vault_id: share.vault_id,
            shares: split_shares,
        }
    }

    /// Merges two VaultShare objects belonging to the same vault.
    public fun merge_shares<CoinA, CoinB>(
        share_to_keep: &mut VaultShare<CoinA, CoinB>,
        share_to_burn: VaultShare<CoinA, CoinB>
    ) {
        let VaultShare { id, vault_id, shares } = share_to_burn;
        object::delete(id);

        assert!(share_to_keep.vault_id == vault_id, EInvalidShareVault);
        share_to_keep.shares = share_to_keep.shares + shares;
    }

    // --- Operator Actions: Yield Harvesting & Rebalancing ---

    /// Operator harvests trading fees, deducts the 10-15% performance fee for treasury,
    /// and auto-compounds the remaining 85-90% directly into vault balances.
    public fun harvest_and_compound<CoinA, CoinB>(
        _cap: &OperatorCap,
        vault: &mut Vault<CoinA, CoinB>,
        fee_coin_a: Coin<CoinA>,
        fee_coin_b: Coin<CoinB>,
        ctx: &mut TxContext
    ) {
        let gross_a = coin::value(&fee_coin_a);
        let gross_b = coin::value(&fee_coin_b);

        let perf_fee_a = (gross_a * vault.fee_rate_bps) / 10000;
        let perf_fee_b = (gross_b * vault.fee_rate_bps) / 10000;

        let mut fee_bal_a = coin::into_balance(fee_coin_a);
        let mut fee_bal_b = coin::into_balance(fee_coin_b);

        // Transfer performance fee to protocol treasury
        if (perf_fee_a > 0) {
            let treasury_coin_a = coin::from_balance(balance::split(&mut fee_bal_a, perf_fee_a), ctx);
            transfer::public_transfer(treasury_coin_a, vault.fee_treasury);
        };

        if (perf_fee_b > 0) {
            let treasury_coin_b = coin::from_balance(balance::split(&mut fee_bal_b, perf_fee_b), ctx);
            transfer::public_transfer(treasury_coin_b, vault.fee_treasury);
        };

        let compounded_a = balance::value(&fee_bal_a);
        let compounded_b = balance::value(&fee_bal_b);

        // Auto-compound remaining 85-90% directly into vault liquidity
        balance::join(&mut vault.balance_a, fee_bal_a);
        balance::join(&mut vault.balance_b, fee_bal_b);

        let vault_id = object::uid_to_inner(&vault.id);

        event::emit(PerformanceFeePaidEvent {
            vault_id,
            treasury: vault.fee_treasury,
            fee_a: perf_fee_a,
            fee_b: perf_fee_b,
        });

        event::emit(FeeHarvestedEvent {
            vault_id,
            gross_fee_a: gross_a,
            gross_fee_b: gross_b,
            performance_fee_a: perf_fee_a,
            performance_fee_b: perf_fee_b,
            compounded_amount_a: compounded_a,
            compounded_amount_b: compounded_b,
        });
    }

    /// Operator updates the active tick range bounds following an atomic PTB rebalance
    public fun record_rebalance<CoinA, CoinB>(
        _cap: &OperatorCap,
        vault: &mut Vault<CoinA, CoinB>,
        new_lower_tick: u32,
        new_upper_tick: u32,
        timestamp_ms: u64,
        ctx: &mut TxContext
    ) {
        assert!(new_lower_tick < new_upper_tick, EInvalidTicks);

        let old_lower = vault.current_lower_tick;
        let old_upper = vault.current_upper_tick;

        vault.current_lower_tick = new_lower_tick;
        vault.current_upper_tick = new_upper_tick;

        event::emit(RebalanceEvent {
            vault_id: object::uid_to_inner(&vault.id),
            operator: tx_context::sender(ctx),
            old_lower_tick: old_lower,
            old_upper_tick: old_upper,
            new_lower_tick,
            new_upper_tick,
            timestamp_ms,
        });
    }

    // --- Admin Setters ---

    public fun set_fee_rate<CoinA, CoinB>(
        _admin: &VaultAdminCap,
        vault: &mut Vault<CoinA, CoinB>,
        new_fee_rate_bps: u64
    ) {
        assert!(new_fee_rate_bps <= MAX_FEE_BPS, EFeeRateTooHigh);
        vault.fee_rate_bps = new_fee_rate_bps;
    }

    public fun set_treasury<CoinA, CoinB>(
        _admin: &VaultAdminCap,
        vault: &mut Vault<CoinA, CoinB>,
        new_treasury: address
    ) {
        vault.fee_treasury = new_treasury;
    }

    // --- Public Getters ---

    public fun total_shares<CoinA, CoinB>(vault: &Vault<CoinA, CoinB>): u64 {
        vault.total_shares
    }

    public fun balances<CoinA, CoinB>(vault: &Vault<CoinA, CoinB>): (u64, u64) {
        (balance::value(&vault.balance_a), balance::value(&vault.balance_b))
    }

    public fun fee_rate<CoinA, CoinB>(vault: &Vault<CoinA, CoinB>): u64 {
        vault.fee_rate_bps
    }

    public fun current_ticks<CoinA, CoinB>(vault: &Vault<CoinA, CoinB>): (u32, u32) {
        (vault.current_lower_tick, vault.current_upper_tick)
    }
}

