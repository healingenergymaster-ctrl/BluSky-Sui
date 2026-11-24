// move/sources/vault.move
// BluSky-Sui Non-Custodial Concentrated Liquidity Vault

module blusky_vault::vault {
    use sui::balance::{Self, Balance};
    use sui::clock::Clock;
    use sui::coin::{Self, Coin};
    use sui::dynamic_field as df;
    use sui::dynamic_object_field as dof;
    use sui::event;
    use cetusclmm::config::GlobalConfig as CetusGlobalConfig;
    use cetusclmm::pool::{Self as cetus_pool, Pool as CetusPool};
    use cetusclmm::position::{Self as cetus_position, Position as CetusPosition};
    use turbos_clmm::pool::{Pool as TurbosPool, Versioned as TurbosVersioned};
    use turbos_clmm::position_manager::{Self as turbos_pm, Positions as TurbosPositions};
    use turbos_clmm::position_nft::{Self as turbos_nft, TurbosPositionNFT};

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
    const EInvalidOperatorCap: u64 = 7;
    const EInvalidAdminCap: u64 = 8;
    const ERebalanceInProgress: u64 = 9;
    const ENotRebalancing: u64 = 10;
    const EPositionAlreadyExists: u64 = 11;
    const EInvalidReceipt: u64 = 12;
    const EInsufficientLiquidity: u64 = 13;
    const EInvalidPool: u64 = 14;
    const ESlippageExceeded: u64 = 15;
    const EWrongVersion: u64 = 16;

    // --- Constants ---
    const MAX_FEE_BPS: u64 = 2500; // Maximum allowed performance fee: 25.0%
    const DEFAULT_FEE_BPS: u64 = 1000; // 10.0% performance fee on trading profits
    const MINIMUM_LIQUIDITY: u64 = 1000; // Minimum liquidity burned permanently on first deposit
    const CURRENT_VERSION: u64 = 4;

    /// Dynamic field key storing package compatibility version
    public struct VersionKey has copy, drop, store {}

    /// Dynamic field key locking the extracted CLMM Position ID during legacy start/finish custody
    public struct ExpectedPosKey has copy, drop, store {}

    /// Dynamic object field key for storing generic CLMM position NFT
    public struct PositionKey has copy, drop, store {}

    /// Hot-potato receipt guaranteeing rebalance completion within the same atomic transaction
    /// Has NO abilities: no `copy`, no `drop`, no `store`, no `key`
    public struct RebalanceReceipt<phantom CoinA, phantom CoinB> {
        vault_id: ID,
    }

    /// Hot-potato receipt guaranteeing active-LP deposit re-locks the position in the same PTB
    public struct DepositLiquidityReceipt<phantom CoinA, phantom CoinB> {
        vault_id: ID,
    }

    /// Hot-potato receipt guaranteeing active-LP withdrawal re-locks the position in the same PTB
    public struct WithdrawLiquidityReceipt<phantom CoinA, phantom CoinB> {
        vault_id: ID,
        shares_burned: u64,
    }

    /// Core Shared Vault Object
    public struct Vault<phantom CoinA, phantom CoinB> has key {
        id: UID,
        balance_a: Balance<CoinA>,
        balance_b: Balance<CoinB>,
        total_shares: u64,
        fee_rate_bps: u64,
        fee_treasury: address,
        clmm_position_id: Option<ID>,
        current_lower_tick: u32,
        current_upper_tick: u32,
        is_rebalancing: bool,
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

        let mut vault = Vault<CoinA, CoinB> {
            id: vault_uid,
            balance_a: balance::zero<CoinA>(),
            balance_b: balance::zero<CoinB>(),
            total_shares: 0,
            fee_rate_bps,
            fee_treasury,
            clmm_position_id: option::none(),
            current_lower_tick: 0,
            current_upper_tick: 0,
            is_rebalancing: false,
        };
        df::add(&mut vault.id, VersionKey {}, CURRENT_VERSION);

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

    /// Creates a new vault using default fee rate (10%)
    public fun create_vault_default<CoinA, CoinB>(
        fee_treasury: address,
        ctx: &mut TxContext
    ) {
        create_vault<CoinA, CoinB>(DEFAULT_FEE_BPS, fee_treasury, ctx);
    }

    fun assert_version<CoinA, CoinB>(vault: &Vault<CoinA, CoinB>) {
        if (df::exists(&vault.id, VersionKey {})) {
            assert!(*df::borrow<VersionKey, u64>(&vault.id, VersionKey {}) == CURRENT_VERSION, EWrongVersion);
        };
    }

    /// Absorbs pro-rata idle vault balances (rounded up) when minting active-LP shares
    /// so idle dust/reserves cannot be diluted or siphoned via deposit_*_active.
    fun absorb_pro_rata_idle<CoinA, CoinB>(
        vault: &mut Vault<CoinA, CoinB>,
        bal_a: &mut Balance<CoinA>,
        bal_b: &mut Balance<CoinB>,
        delta_liq: u128,
        liq_before: u128
    ): (u64, u64) {
        let idle_a = balance::value(&vault.balance_a);
        let idle_b = balance::value(&vault.balance_b);
        let need_idle_a = if (idle_a == 0) {
            0
        } else {
            (((delta_liq * (idle_a as u128)) + liq_before - 1) / liq_before) as u64
        };
        let need_idle_b = if (idle_b == 0) {
            0
        } else {
            (((delta_liq * (idle_b as u128)) + liq_before - 1) / liq_before) as u64
        };
        assert!(
            balance::value(bal_a) >= need_idle_a && balance::value(bal_b) >= need_idle_b,
            EInsufficientLiquidity
        );
        if (need_idle_a > 0) {
            balance::join(&mut vault.balance_a, balance::split(bal_a, need_idle_a));
        };
        if (need_idle_b > 0) {
            balance::join(&mut vault.balance_b, balance::split(bal_b, need_idle_b));
        };
        (need_idle_a, need_idle_b)
    }

    // --- User Actions: Deposit & Withdraw ---

    /// Deposits CoinA and CoinB into an idle vault (before a CLMM position is active), minting transferable VaultShares.
    /// Locks MINIMUM_LIQUIDITY permanently on the initial deposit to prevent share inflation attacks.
    public fun deposit<CoinA, CoinB>(
        vault: &mut Vault<CoinA, CoinB>,
        coin_a: Coin<CoinA>,
        coin_b: Coin<CoinB>,
        ctx: &mut TxContext
    ): VaultShare<CoinA, CoinB> {
        assert_version(vault);
        assert!(!vault.is_rebalancing, ERebalanceInProgress);
        assert!(!dof::exists(&vault.id, PositionKey {}), EPositionAlreadyExists);

        let amount_a = coin::value(&coin_a);
        let amount_b = coin::value(&coin_b);
        assert!(amount_a > 0 || amount_b > 0, EZeroDeposit);

        let cur_val_a = balance::value(&vault.balance_a);
        let cur_val_b = balance::value(&vault.balance_b);

        let shares_to_mint: u64;

        if (vault.total_shares == 0) {
            let initial_sum = amount_a + amount_b;
            assert!(initial_sum > MINIMUM_LIQUIDITY, EInsufficientLiquidity);
            vault.total_shares = MINIMUM_LIQUIDITY;
            shares_to_mint = initial_sum - MINIMUM_LIQUIDITY;
        } else if (cur_val_a > 0 && cur_val_b > 0) {
            assert!(amount_a > 0 && amount_b > 0, EZeroDeposit);
            let share_a = (((amount_a as u128) * (vault.total_shares as u128)) / (cur_val_a as u128)) as u64;
            let share_b = (((amount_b as u128) * (vault.total_shares as u128)) / (cur_val_b as u128)) as u64;
            shares_to_mint = if (share_a < share_b) { share_a } else { share_b };
        } else if (cur_val_a > 0) {
            shares_to_mint = (((amount_a as u128) * (vault.total_shares as u128)) / (cur_val_a as u128)) as u64;
        } else {
            shares_to_mint = (((amount_b as u128) * (vault.total_shares as u128)) / (cur_val_b as u128)) as u64;
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

    /// Redeems VaultShares for the underlying CoinA and CoinB pro-rata.
    /// Blocked while vault is rebalancing.
    public fun withdraw<CoinA, CoinB>(
        vault: &mut Vault<CoinA, CoinB>,
        share: VaultShare<CoinA, CoinB>,
        ctx: &mut TxContext
    ): (Coin<CoinA>, Coin<CoinB>) {
        let VaultShare { id, vault_id, shares } = share;
        object::delete(id);

        assert!(vault_id == object::uid_to_inner(&vault.id), EInvalidShareVault);
        assert!(shares > 0, EZeroShares);
        assert_version(vault);
        assert!(!vault.is_rebalancing, ERebalanceInProgress);
        assert!(!dof::exists(&vault.id, PositionKey {}), EPositionAlreadyExists);
        assert!(vault.total_shares > shares, EInsufficientShares);

        let total_val_a = balance::value(&vault.balance_a);
        let total_val_b = balance::value(&vault.balance_b);

        let amount_a_out = (((shares as u128) * (total_val_a as u128)) / (vault.total_shares as u128)) as u64;
        let amount_b_out = (((shares as u128) * (total_val_b as u128)) / (vault.total_shares as u128)) as u64;

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

    /// Operator harvests trading fees, deducts the performance fee for treasury,
    /// and auto-compounds the remaining fees directly into vault balances.
    public fun harvest_and_compound<CoinA, CoinB>(
        cap: &OperatorCap,
        vault: &mut Vault<CoinA, CoinB>,
        fee_coin_a: Coin<CoinA>,
        fee_coin_b: Coin<CoinB>,
        ctx: &mut TxContext
    ) {
        assert!(cap.vault_id == object::uid_to_inner(&vault.id), EInvalidOperatorCap);
        assert_version(vault);
        assert!(!vault.is_rebalancing, ERebalanceInProgress);

        let gross_a = coin::value(&fee_coin_a);
        let gross_b = coin::value(&fee_coin_b);

        let perf_fee_a = (((gross_a as u128) * (vault.fee_rate_bps as u128)) / 10000) as u64;
        let perf_fee_b = (((gross_b as u128) * (vault.fee_rate_bps as u128)) / 10000) as u64;

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

        // Auto-compound remaining fees directly into vault liquidity
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

    /// Operator updates the active tick range bounds
    public fun record_rebalance<CoinA, CoinB>(
        cap: &OperatorCap,
        vault: &mut Vault<CoinA, CoinB>,
        new_lower_tick: u32,
        new_upper_tick: u32,
        timestamp_ms: u64,
        ctx: &mut TxContext
    ) {
        assert!(cap.vault_id == object::uid_to_inner(&vault.id), EInvalidOperatorCap);
        assert_version(vault);
        assert!(!vault.is_rebalancing, ERebalanceInProgress);
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

    /// Seeding or depositing initial generic CLMM position NFT into the vault
    public fun deposit_position<CoinA, CoinB, Pos: key + store>(
        cap: &OperatorCap,
        vault: &mut Vault<CoinA, CoinB>,
        pos: Pos
    ) {
        assert!(cap.vault_id == object::uid_to_inner(&vault.id), EInvalidOperatorCap);
        assert_version(vault);
        assert!(!vault.is_rebalancing, ERebalanceInProgress);
        assert!(!dof::exists(&vault.id, PositionKey {}), EPositionAlreadyExists);

        vault.clmm_position_id = option::some(object::id(&pos));
        dof::add(&mut vault.id, PositionKey {}, pos);
    }

    /// Initiates an atomic PTB rebalance.
    /// Extracts the held CLMM position NFT (if any), extracts vault coin balances, sets `is_rebalancing = true`,
    /// and issues a non-storable, non-droppable `RebalanceReceipt` hot potato.
    public fun start_rebalance<CoinA, CoinB, Pos: key + store>(
        cap: &OperatorCap,
        vault: &mut Vault<CoinA, CoinB>,
        ctx: &mut TxContext
    ): (Option<Pos>, Coin<CoinA>, Coin<CoinB>, RebalanceReceipt<CoinA, CoinB>) {
        assert!(cap.vault_id == object::uid_to_inner(&vault.id), EInvalidOperatorCap);
        assert_version(vault);
        assert!(!vault.is_rebalancing, ERebalanceInProgress);

        vault.is_rebalancing = true;

        let pos_opt = if (dof::exists(&vault.id, PositionKey {})) {
            let pos = dof::remove<PositionKey, Pos>(&mut vault.id, PositionKey {});
            vault.clmm_position_id = option::none();
            option::some(pos)
        } else {
            option::none()
        };

        let val_a = balance::value(&vault.balance_a);
        let val_b = balance::value(&vault.balance_b);

        let coin_a = coin::take(&mut vault.balance_a, val_a, ctx);
        let coin_b = coin::take(&mut vault.balance_b, val_b, ctx);

        let receipt = RebalanceReceipt<CoinA, CoinB> {
            vault_id: object::uid_to_inner(&vault.id),
        };

        (pos_opt, coin_a, coin_b, receipt)
    }

    /// Completes an atomic PTB rebalance by consuming the `RebalanceReceipt` hot potato.
    /// Re-deposits the newly created position NFT (if any), rejoins remaining coins, updates ticks,
    /// resets `is_rebalancing = false`, and emits `RebalanceEvent`.
    public fun finish_rebalance<CoinA, CoinB, Pos: key + store>(
        vault: &mut Vault<CoinA, CoinB>,
        receipt: RebalanceReceipt<CoinA, CoinB>,
        new_pos: Option<Pos>,
        return_a: Coin<CoinA>,
        return_b: Coin<CoinB>,
        new_lower_tick: u32,
        new_upper_tick: u32,
        timestamp_ms: u64,
        ctx: &mut TxContext
    ) {
        let RebalanceReceipt { vault_id } = receipt;
        assert_version(vault);
        assert!(vault_id == object::uid_to_inner(&vault.id), EInvalidReceipt);
        assert!(vault.is_rebalancing, ENotRebalancing);

        vault.is_rebalancing = false;

        if (option::is_some(&new_pos)) {
            let pos = option::destroy_some(new_pos);
            assert!(!dof::exists(&vault.id, PositionKey {}), EPositionAlreadyExists);
            vault.clmm_position_id = option::some(object::id(&pos));
            dof::add(&mut vault.id, PositionKey {}, pos);
        } else {
            option::destroy_none(new_pos);
            vault.clmm_position_id = option::none();
        };

        balance::join(&mut vault.balance_a, coin::into_balance(return_a));
        balance::join(&mut vault.balance_b, coin::into_balance(return_b));

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

    // --- Active-LP Browser Deposit & Withdraw (Hot-Potato Protected) ---

    /// Temporarily extracts the active CLMM Position NFT so a zap-deposit PTB can inject
    /// proportional liquidity directly into the existing position.
    public fun start_deposit_liquidity<CoinA, CoinB, Pos: key + store>(
        cap: &OperatorCap,
        vault: &mut Vault<CoinA, CoinB>,
    ): (Pos, DepositLiquidityReceipt<CoinA, CoinB>) {
        assert!(cap.vault_id == object::uid_to_inner(&vault.id), EInvalidOperatorCap);
        assert_version(vault);
        assert!(!vault.is_rebalancing, ERebalanceInProgress);
        assert!(dof::exists(&vault.id, PositionKey {}), EInsufficientLiquidity);

        vault.is_rebalancing = true;
        let pos = dof::remove<PositionKey, Pos>(&mut vault.id, PositionKey {});
        vault.clmm_position_id = option::none();
        df::add(&mut vault.id, ExpectedPosKey {}, object::id(&pos));

        let receipt = DepositLiquidityReceipt<CoinA, CoinB> {
            vault_id: object::uid_to_inner(&vault.id),
        };
        (pos, receipt)
    }

    /// Re-locks the CLMM Position NFT, absorbs any post-add rounding dust into vault balances,
    /// mints proportional VaultShares, emits DepositEvent, and unlocks the vault.
    public fun finish_deposit_liquidity<CoinA, CoinB, Pos: key + store>(
        vault: &mut Vault<CoinA, CoinB>,
        receipt: DepositLiquidityReceipt<CoinA, CoinB>,
        pos: Pos,
        leftover_a: Coin<CoinA>,
        leftover_b: Coin<CoinB>,
        deposited_a_est: u64,
        deposited_b_est: u64,
        shares_to_mint: u64,
        ctx: &mut TxContext
    ): VaultShare<CoinA, CoinB> {
        let DepositLiquidityReceipt { vault_id } = receipt;
        assert_version(vault);
        assert!(vault_id == object::uid_to_inner(&vault.id), EInvalidReceipt);
        assert!(vault.is_rebalancing, ENotRebalancing);
        assert!(shares_to_mint > 0, EZeroShares);
        assert!(!dof::exists(&vault.id, PositionKey {}), EPositionAlreadyExists);
        assert!(df::exists(&vault.id, ExpectedPosKey {}), EInvalidReceipt);
        let expected_pos_id = df::remove<ExpectedPosKey, ID>(&mut vault.id, ExpectedPosKey {});
        assert!(object::id(&pos) == expected_pos_id, EInvalidReceipt);

        vault.is_rebalancing = false;
        vault.clmm_position_id = option::some(object::id(&pos));
        dof::add(&mut vault.id, PositionKey {}, pos);

        balance::join(&mut vault.balance_a, coin::into_balance(leftover_a));
        balance::join(&mut vault.balance_b, coin::into_balance(leftover_b));

        vault.total_shares = vault.total_shares + shares_to_mint;

        event::emit(DepositEvent {
            vault_id,
            depositor: tx_context::sender(ctx),
            shares_minted: shares_to_mint,
            amount_a: deposited_a_est,
            amount_b: deposited_b_est,
        });

        VaultShare<CoinA, CoinB> {
            id: object::new(ctx),
            vault_id,
            shares: shares_to_mint,
        }
    }

    /// Burns a user's VaultShare, extracts the active CLMM Position NFT and pro-rata idle reserves,
    /// and returns a hot-potato `WithdrawLiquidityReceipt` for atomic `remove_liquidity`.
    public fun start_withdraw_liquidity<CoinA, CoinB, Pos: key + store>(
        cap: &OperatorCap,
        vault: &mut Vault<CoinA, CoinB>,
        share: VaultShare<CoinA, CoinB>,
        ctx: &mut TxContext
    ): (Pos, Coin<CoinA>, Coin<CoinB>, WithdrawLiquidityReceipt<CoinA, CoinB>) {
        assert!(cap.vault_id == object::uid_to_inner(&vault.id), EInvalidOperatorCap);
        assert_version(vault);
        assert!(!vault.is_rebalancing, ERebalanceInProgress);
        assert!(dof::exists(&vault.id, PositionKey {}), EInsufficientLiquidity);

        let VaultShare { id, vault_id: share_vault_id, shares } = share;
        object::delete(id);

        let v_id = object::uid_to_inner(&vault.id);
        assert!(share_vault_id == v_id, EInvalidShareVault);
        assert!(shares > 0, EZeroShares);
        assert!(vault.total_shares > shares, EInsufficientShares);

        let total_a = balance::value(&vault.balance_a);
        let total_b = balance::value(&vault.balance_b);
        let idle_out_a = (((shares as u128) * (total_a as u128)) / (vault.total_shares as u128)) as u64;
        let idle_out_b = (((shares as u128) * (total_b as u128)) / (vault.total_shares as u128)) as u64;

        vault.total_shares = vault.total_shares - shares;
        vault.is_rebalancing = true;

        let pos = dof::remove<PositionKey, Pos>(&mut vault.id, PositionKey {});
        vault.clmm_position_id = option::none();
        df::add(&mut vault.id, ExpectedPosKey {}, object::id(&pos));

        let coin_a = coin::take(&mut vault.balance_a, idle_out_a, ctx);
        let coin_b = coin::take(&mut vault.balance_b, idle_out_b, ctx);

        let receipt = WithdrawLiquidityReceipt<CoinA, CoinB> {
            vault_id: v_id,
            shares_burned: shares,
        };
        (pos, coin_a, coin_b, receipt)
    }

    /// Re-locks the CLMM Position NFT after pro-rata `remove_liquidity`, emits WithdrawEvent,
    /// and unlocks the vault.
    public fun finish_withdraw_liquidity<CoinA, CoinB, Pos: key + store>(
        vault: &mut Vault<CoinA, CoinB>,
        receipt: WithdrawLiquidityReceipt<CoinA, CoinB>,
        pos: Pos,
        returned_a_est: u64,
        returned_b_est: u64,
        ctx: &mut TxContext
    ) {
        let WithdrawLiquidityReceipt { vault_id, shares_burned } = receipt;
        assert_version(vault);
        assert!(vault_id == object::uid_to_inner(&vault.id), EInvalidReceipt);
        assert!(vault.is_rebalancing, ENotRebalancing);
        assert!(!dof::exists(&vault.id, PositionKey {}), EPositionAlreadyExists);
        assert!(df::exists(&vault.id, ExpectedPosKey {}), EInvalidReceipt);
        let expected_pos_id = df::remove<ExpectedPosKey, ID>(&mut vault.id, ExpectedPosKey {});
        assert!(object::id(&pos) == expected_pos_id, EInvalidReceipt);

        vault.is_rebalancing = false;
        vault.clmm_position_id = option::some(object::id(&pos));
        dof::add(&mut vault.id, PositionKey {}, pos);

        event::emit(WithdrawEvent {
            vault_id,
            withdrawer: tx_context::sender(ctx),
            shares_burned,
            amount_a_returned: returned_a_est,
            amount_b_returned: returned_b_est,
        });
    }

    // --- Permissionless Active-LP Deposit & Withdraw (On-Chain Liquidity Invariants) ---

    /// Permissionlessly deposits CoinA/CoinB directly into the vault's active Cetus CLMM Position
    /// without transferring custody of the Position NFT or requiring OperatorCap.
    /// Computes minted shares strictly from on-chain Cetus Position liquidity delta (`delta_liq / liq_before`).
    public fun deposit_cetus_active<CoinA, CoinB>(
        vault: &mut Vault<CoinA, CoinB>,
        config: &CetusGlobalConfig,
        pool: &mut CetusPool<CoinA, CoinB>,
        coin_a: Coin<CoinA>,
        coin_b: Coin<CoinB>,
        fix_amount: u64,
        fix_amount_a: bool,
        min_shares: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ): (VaultShare<CoinA, CoinB>, Coin<CoinA>, Coin<CoinB>) {
        assert_version(vault);
        assert!(!vault.is_rebalancing, ERebalanceInProgress);
        assert!(dof::exists(&vault.id, PositionKey {}), EInsufficientLiquidity);
        assert!(vault.total_shares > 0, EInsufficientLiquidity);
        assert!(fix_amount > 0, EZeroDeposit);

        let (liq_before, delta_liq, pay_a, pay_b, mut bal_a, mut bal_b) = {
            let mut bal_a = coin::into_balance(coin_a);
            let mut bal_b = coin::into_balance(coin_b);
            let pos = dof::borrow_mut<PositionKey, CetusPosition>(&mut vault.id, PositionKey {});
            assert!(object::id(pool) == cetus_position::pool_id(pos), EInvalidPool);

            let liq_before = cetus_position::liquidity(pos);
            assert!(liq_before > 0, EInsufficientLiquidity);

            let add_receipt = cetus_pool::add_liquidity_fix_coin(
                config,
                pool,
                pos,
                fix_amount,
                fix_amount_a,
                clock
            );
            let (pay_a, pay_b) = cetus_pool::add_liquidity_pay_amount(&add_receipt);
            let pay_bal_a = balance::split(&mut bal_a, pay_a);
            let pay_bal_b = balance::split(&mut bal_b, pay_b);
            cetus_pool::repay_add_liquidity(config, pool, pay_bal_a, pay_bal_b, add_receipt);

            let liq_after = cetus_position::liquidity(pos);
            assert!(liq_after > liq_before, EZeroDeposit);
            (liq_before, liq_after - liq_before, pay_a, pay_b, bal_a, bal_b)
        };

        let (idle_in_a, idle_in_b) = absorb_pro_rata_idle(vault, &mut bal_a, &mut bal_b, delta_liq, liq_before);
        let shares_to_mint = ((delta_liq * (vault.total_shares as u128)) / liq_before) as u64;
        assert!(shares_to_mint > 0, EZeroShares);
        assert!(shares_to_mint >= min_shares, ESlippageExceeded);

        vault.total_shares = vault.total_shares + shares_to_mint;
        let vault_id = object::uid_to_inner(&vault.id);

        event::emit(DepositEvent {
            vault_id,
            depositor: tx_context::sender(ctx),
            shares_minted: shares_to_mint,
            amount_a: pay_a + idle_in_a,
            amount_b: pay_b + idle_in_b,
        });

        let share = VaultShare<CoinA, CoinB> {
            id: object::new(ctx),
            vault_id,
            shares: shares_to_mint,
        };
        (share, coin::from_balance(bal_a, ctx), coin::from_balance(bal_b, ctx))
    }

    /// Permissionlessly redeems a user's VaultShare against the vault's active Cetus Position
    /// without requiring OperatorCap. Only the VaultShare owner can authorize the burn.
    public fun withdraw_cetus_active<CoinA, CoinB>(
        vault: &mut Vault<CoinA, CoinB>,
        config: &CetusGlobalConfig,
        pool: &mut CetusPool<CoinA, CoinB>,
        share: VaultShare<CoinA, CoinB>,
        min_amount_a: u64,
        min_amount_b: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ): (Coin<CoinA>, Coin<CoinB>) {
        assert_version(vault);
        assert!(!vault.is_rebalancing, ERebalanceInProgress);
        assert!(dof::exists(&vault.id, PositionKey {}), EInsufficientLiquidity);

        let VaultShare { id, vault_id: share_vault_id, shares } = share;
        object::delete(id);

        let v_id = object::uid_to_inner(&vault.id);
        assert!(share_vault_id == v_id, EInvalidShareVault);
        assert!(shares > 0, EZeroShares);
        assert!(vault.total_shares > shares, EInsufficientShares);

        let total_shares_before = vault.total_shares;
        let total_a = balance::value(&vault.balance_a);
        let total_b = balance::value(&vault.balance_b);
        let idle_out_a = (((shares as u128) * (total_a as u128)) / (total_shares_before as u128)) as u64;
        let idle_out_b = (((shares as u128) * (total_b as u128)) / (total_shares_before as u128)) as u64;

        let pos = dof::borrow_mut<PositionKey, CetusPosition>(&mut vault.id, PositionKey {});
        assert!(object::id(pool) == cetus_position::pool_id(pos), EInvalidPool);

        let liq_before = cetus_position::liquidity(pos);
        assert!(liq_before > 0, EInsufficientLiquidity);
        let liq_to_remove = ((shares as u128) * liq_before) / (total_shares_before as u128);
        assert!(liq_to_remove > 0, EInsufficientLiquidity);

        let (rem_bal_a, rem_bal_b) = cetus_pool::remove_liquidity(
            config,
            pool,
            pos,
            liq_to_remove,
            clock
        );

        vault.total_shares = total_shares_before - shares;

        let mut out_bal_a = balance::split(&mut vault.balance_a, idle_out_a);
        let mut out_bal_b = balance::split(&mut vault.balance_b, idle_out_b);
        balance::join(&mut out_bal_a, rem_bal_a);
        balance::join(&mut out_bal_b, rem_bal_b);

        let total_out_a = balance::value(&out_bal_a);
        let total_out_b = balance::value(&out_bal_b);
        assert!(total_out_a >= min_amount_a && total_out_b >= min_amount_b, ESlippageExceeded);

        event::emit(WithdrawEvent {
            vault_id: v_id,
            withdrawer: tx_context::sender(ctx),
            shares_burned: shares,
            amount_a_returned: total_out_a,
            amount_b_returned: total_out_b,
        });

        (coin::from_balance(out_bal_a, ctx), coin::from_balance(out_bal_b, ctx))
    }

    /// Permissionlessly deposits CoinA/CoinB directly into the vault's active Turbos CLMM Position
    /// without transferring custody of the NFT or requiring OperatorCap.
    public fun deposit_turbos_active<CoinA, CoinB, FeeType>(
        vault: &mut Vault<CoinA, CoinB>,
        pool: &mut TurbosPool<CoinA, CoinB, FeeType>,
        positions: &mut TurbosPositions,
        coin_a: Coin<CoinA>,
        coin_b: Coin<CoinB>,
        amount_a_desired: u64,
        amount_b_desired: u64,
        min_shares: u64,
        deadline: u64,
        clock: &Clock,
        versioned: &TurbosVersioned,
        ctx: &mut TxContext
    ): (VaultShare<CoinA, CoinB>, Coin<CoinA>, Coin<CoinB>) {
        assert_version(vault);
        assert!(!vault.is_rebalancing, ERebalanceInProgress);
        assert!(dof::exists(&vault.id, PositionKey {}), EInsufficientLiquidity);
        assert!(vault.total_shares > 0, EInsufficientLiquidity);

        let in_a_val = coin::value(&coin_a);
        let in_b_val = coin::value(&coin_b);
        assert!(in_a_val > 0 || in_b_val > 0, EZeroDeposit);

        let (liq_before, delta_liq, mut left_bal_a, mut left_bal_b) = {
            let nft = dof::borrow_mut<PositionKey, TurbosPositionNFT>(&mut vault.id, PositionKey {});
            assert!(object::id(pool) == turbos_nft::pool_id(nft), EInvalidPool);

            let nft_addr = object::id_to_address(&object::id(nft));
            let (_, _, liq_before) = turbos_pm::get_position_info(positions, nft_addr);
            assert!(liq_before > 0, EInsufficientLiquidity);

            let (left_a, left_b) = turbos_pm::increase_liquidity_with_return_(
                pool,
                positions,
                vector[coin_a],
                vector[coin_b],
                nft,
                amount_a_desired,
                amount_b_desired,
                0,
                0,
                deadline,
                clock,
                versioned,
                ctx
            );

            let (_, _, liq_after) = turbos_pm::get_position_info(positions, nft_addr);
            assert!(liq_after > liq_before, EZeroDeposit);
            (liq_before, liq_after - liq_before, coin::into_balance(left_a), coin::into_balance(left_b))
        };

        let (_idle_in_a, _idle_in_b) = absorb_pro_rata_idle(vault, &mut left_bal_a, &mut left_bal_b, delta_liq, liq_before);
        let shares_to_mint = ((delta_liq * (vault.total_shares as u128)) / liq_before) as u64;
        assert!(shares_to_mint > 0, EZeroShares);
        assert!(shares_to_mint >= min_shares, ESlippageExceeded);

        vault.total_shares = vault.total_shares + shares_to_mint;
        let vault_id = object::uid_to_inner(&vault.id);
        let left_a_val = balance::value(&left_bal_a);
        let left_b_val = balance::value(&left_bal_b);
        let used_a = if (in_a_val >= left_a_val) { in_a_val - left_a_val } else { 0 };
        let used_b = if (in_b_val >= left_b_val) { in_b_val - left_b_val } else { 0 };

        event::emit(DepositEvent {
            vault_id,
            depositor: tx_context::sender(ctx),
            shares_minted: shares_to_mint,
            amount_a: used_a,
            amount_b: used_b,
        });

        let share = VaultShare<CoinA, CoinB> {
            id: object::new(ctx),
            vault_id,
            shares: shares_to_mint,
        };
        (share, coin::from_balance(left_bal_a, ctx), coin::from_balance(left_bal_b, ctx))
    }

    /// Permissionlessly redeems a user's VaultShare against the vault's active Turbos Position
    /// without requiring OperatorCap. Only the VaultShare owner can authorize the burn.
    public fun withdraw_turbos_active<CoinA, CoinB, FeeType>(
        vault: &mut Vault<CoinA, CoinB>,
        pool: &mut TurbosPool<CoinA, CoinB, FeeType>,
        positions: &mut TurbosPositions,
        share: VaultShare<CoinA, CoinB>,
        min_amount_a: u64,
        min_amount_b: u64,
        deadline: u64,
        clock: &Clock,
        versioned: &TurbosVersioned,
        ctx: &mut TxContext
    ): (Coin<CoinA>, Coin<CoinB>) {
        assert_version(vault);
        assert!(!vault.is_rebalancing, ERebalanceInProgress);
        assert!(dof::exists(&vault.id, PositionKey {}), EInsufficientLiquidity);

        let VaultShare { id, vault_id: share_vault_id, shares } = share;
        object::delete(id);

        let v_id = object::uid_to_inner(&vault.id);
        assert!(share_vault_id == v_id, EInvalidShareVault);
        assert!(shares > 0, EZeroShares);
        assert!(vault.total_shares > shares, EInsufficientShares);

        let total_shares_before = vault.total_shares;
        let total_a = balance::value(&vault.balance_a);
        let total_b = balance::value(&vault.balance_b);
        let idle_out_a = (((shares as u128) * (total_a as u128)) / (total_shares_before as u128)) as u64;
        let idle_out_b = (((shares as u128) * (total_b as u128)) / (total_shares_before as u128)) as u64;

        let nft = dof::borrow_mut<PositionKey, TurbosPositionNFT>(&mut vault.id, PositionKey {});
        assert!(object::id(pool) == turbos_nft::pool_id(nft), EInvalidPool);

        let nft_addr = object::id_to_address(&object::id(nft));
        let (_, _, liq_before) = turbos_pm::get_position_info(positions, nft_addr);
        assert!(liq_before > 0, EInsufficientLiquidity);
        let liq_to_remove = ((shares as u128) * liq_before) / (total_shares_before as u128);
        assert!(liq_to_remove > 0, EInsufficientLiquidity);

        let (mut rem_coin_a, mut rem_coin_b) = turbos_pm::decrease_liquidity_with_return_(
            pool,
            positions,
            nft,
            liq_to_remove,
            0,
            0,
            deadline,
            clock,
            versioned,
            ctx
        );

        vault.total_shares = total_shares_before - shares;

        let idle_coin_a = coin::take(&mut vault.balance_a, idle_out_a, ctx);
        let idle_coin_b = coin::take(&mut vault.balance_b, idle_out_b, ctx);
        coin::join(&mut rem_coin_a, idle_coin_a);
        coin::join(&mut rem_coin_b, idle_coin_b);

        let total_out_a = coin::value(&rem_coin_a);
        let total_out_b = coin::value(&rem_coin_b);
        assert!(total_out_a >= min_amount_a && total_out_b >= min_amount_b, ESlippageExceeded);

        event::emit(WithdrawEvent {
            vault_id: v_id,
            withdrawer: tx_context::sender(ctx),
            shares_burned: shares,
            amount_a_returned: total_out_a,
            amount_b_returned: total_out_b,
        });

        (rem_coin_a, rem_coin_b)
    }

    // --- Admin Setters ---

    public fun set_fee_rate<CoinA, CoinB>(
        admin: &VaultAdminCap,
        vault: &mut Vault<CoinA, CoinB>,
        new_fee_rate_bps: u64
    ) {
        assert!(admin.vault_id == object::uid_to_inner(&vault.id), EInvalidAdminCap);
        assert!(new_fee_rate_bps <= MAX_FEE_BPS, EFeeRateTooHigh);
        vault.fee_rate_bps = new_fee_rate_bps;
    }

    public fun set_treasury<CoinA, CoinB>(
        admin: &VaultAdminCap,
        vault: &mut Vault<CoinA, CoinB>,
        new_treasury: address
    ) {
        assert!(admin.vault_id == object::uid_to_inner(&vault.id), EInvalidAdminCap);
        vault.fee_treasury = new_treasury;
    }

    public fun migrate_version<CoinA, CoinB>(
        admin: &VaultAdminCap,
        vault: &mut Vault<CoinA, CoinB>
    ) {
        assert!(admin.vault_id == object::uid_to_inner(&vault.id), EInvalidAdminCap);
        if (df::exists(&vault.id, VersionKey {})) {
            let v = df::borrow_mut<VersionKey, u64>(&mut vault.id, VersionKey {});
            *v = CURRENT_VERSION;
        } else {
            df::add(&mut vault.id, VersionKey {}, CURRENT_VERSION);
        };
    }

    public fun current_version(): u64 {
        CURRENT_VERSION
    }

    public fun vault_version<CoinA, CoinB>(vault: &Vault<CoinA, CoinB>): u64 {
        if (df::exists(&vault.id, VersionKey {})) {
            *df::borrow<VersionKey, u64>(&vault.id, VersionKey {})
        } else {
            0
        }
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

    public fun fee_treasury<CoinA, CoinB>(vault: &Vault<CoinA, CoinB>): address {
        vault.fee_treasury
    }

    public fun current_ticks<CoinA, CoinB>(vault: &Vault<CoinA, CoinB>): (u32, u32) {
        (vault.current_lower_tick, vault.current_upper_tick)
    }

    public fun has_position<CoinA, CoinB>(vault: &Vault<CoinA, CoinB>): bool {
        dof::exists(&vault.id, PositionKey {})
    }

    public fun position_id<CoinA, CoinB>(vault: &Vault<CoinA, CoinB>): Option<ID> {
        vault.clmm_position_id
    }

    public fun clmm_position_id<CoinA, CoinB>(vault: &Vault<CoinA, CoinB>): Option<ID> {
        vault.clmm_position_id
    }

    public fun is_rebalancing<CoinA, CoinB>(vault: &Vault<CoinA, CoinB>): bool {
        vault.is_rebalancing
    }

    public fun borrow_position<CoinA, CoinB, Pos: key + store>(vault: &Vault<CoinA, CoinB>): &Pos {
        dof::borrow(&vault.id, PositionKey {})
    }

    public fun receipt_vault_id<CoinA, CoinB>(receipt: &RebalanceReceipt<CoinA, CoinB>): ID {
        receipt.vault_id
    }

    public fun share_shares<CoinA, CoinB>(share: &VaultShare<CoinA, CoinB>): u64 {
        share.shares
    }

    public fun share_vault_id<CoinA, CoinB>(share: &VaultShare<CoinA, CoinB>): ID {
        share.vault_id
    }

    public fun operator_cap_vault_id(cap: &OperatorCap): ID {
        cap.vault_id
    }

    public fun admin_cap_vault_id(cap: &VaultAdminCap): ID {
        cap.vault_id
    }

    public fun default_fee_bps(): u64 {
        DEFAULT_FEE_BPS
    }

    public fun max_fee_bps(): u64 {
        MAX_FEE_BPS
    }

    public fun minimum_liquidity(): u64 {
        MINIMUM_LIQUIDITY
    }

    // --- Error Code Getters for Testing ---
    #[test_only]
    public fun err_zero_deposit(): u64 { EZeroDeposit }
    #[test_only]
    public fun err_zero_shares(): u64 { EZeroShares }
    #[test_only]
    public fun err_invalid_share_vault(): u64 { EInvalidShareVault }
    #[test_only]
    public fun err_fee_rate_too_high(): u64 { EFeeRateTooHigh }
    #[test_only]
    public fun err_invalid_ticks(): u64 { EInvalidTicks }
    #[test_only]
    public fun err_insufficient_shares(): u64 { EInsufficientShares }
    #[test_only]
    public fun err_invalid_operator_cap(): u64 { EInvalidOperatorCap }
    #[test_only]
    public fun err_invalid_admin_cap(): u64 { EInvalidAdminCap }
    #[test_only]
    public fun err_rebalance_in_progress(): u64 { ERebalanceInProgress }
    #[test_only]
    public fun err_not_rebalancing(): u64 { ENotRebalancing }
    #[test_only]
    public fun err_position_already_exists(): u64 { EPositionAlreadyExists }
    #[test_only]
    public fun err_invalid_receipt(): u64 { EInvalidReceipt }
    #[test_only]
    public fun err_insufficient_liquidity(): u64 { EInsufficientLiquidity }
    #[test_only]
    public fun err_invalid_pool(): u64 { EInvalidPool }
    #[test_only]
    public fun err_slippage_exceeded(): u64 { ESlippageExceeded }
    #[test_only]
    public fun err_wrong_version(): u64 { EWrongVersion }
    #[test_only]
    public fun set_version_for_testing<CoinA, CoinB>(vault: &mut Vault<CoinA, CoinB>, version: u64) {
        if (df::exists(&vault.id, VersionKey {})) {
            let v = df::borrow_mut<VersionKey, u64>(&mut vault.id, VersionKey {});
            *v = version;
        } else {
            df::add(&mut vault.id, VersionKey {}, version);
        };
    }
}
