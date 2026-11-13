// move/tests/vault_tests.move
#[test_only]
module blusky_vault::vault_tests {
    use sui::coin::{Self, Coin};
    use sui::test_scenario::{Self as ts, Scenario};
    use blusky_vault::vault::{
        Self,
        Vault,
        OperatorCap,
        VaultAdminCap,
    };

    // Addresses
    const ADMIN: address = @0xA;
    const TREASURY: address = @0xC;
    const USER1: address = @0x1;
    const USER2: address = @0x2;

    // Test coin types
    public struct SUI_TEST has drop {}
    public struct USDC_TEST has drop {}

    // Mock Position NFT
    public struct MockPositionNFT has key, store {
        id: UID,
        tick_lower: u32,
        tick_upper: u32,
        liquidity: u128,
    }

    public fun new_mock_position(
        tick_lower: u32,
        tick_upper: u32,
        liquidity: u128,
        ctx: &mut TxContext,
    ): MockPositionNFT {
        MockPositionNFT {
            id: object::new(ctx),
            tick_lower,
            tick_upper,
            liquidity,
        }
    }

    public fun destroy_mock_position(pos: MockPositionNFT) {
        let MockPositionNFT { id, tick_lower: _, tick_upper: _, liquidity: _ } = pos;
        object::delete(id);
    }

    // --- Helper: Setup Vault ---
    fun setup_vault(scenario: &mut Scenario): (ID, ID, ID) {
        ts::next_tx(scenario, ADMIN);
        vault::create_vault<SUI_TEST, USDC_TEST>(1000, TREASURY, ts::ctx(scenario));

        ts::next_tx(scenario, ADMIN);
        let vault = ts::take_shared<Vault<SUI_TEST, USDC_TEST>>(scenario);
        let admin_cap = ts::take_from_sender<VaultAdminCap>(scenario);
        let operator_cap = ts::take_from_sender<OperatorCap>(scenario);

        let vault_id = object::id(&vault);
        let admin_id = object::id(&admin_cap);
        let operator_id = object::id(&operator_cap);

        ts::return_shared(vault);
        ts::return_to_sender(scenario, admin_cap);
        ts::return_to_sender(scenario, operator_cap);

        (vault_id, admin_id, operator_id)
    }

    // --- Test 1: Full Lifecycle ---
    #[test]
    fun test_full_lifecycle() {
        let mut scenario = ts::begin(ADMIN);
        setup_vault(&mut scenario);

        // User 1 Deposit (Initial deposit: MINIMUM_LIQUIDITY burned permanently)
        ts::next_tx(&mut scenario, USER1);
        let mut vault = ts::take_shared<Vault<SUI_TEST, USDC_TEST>>(&scenario);
        let coin_a1 = coin::mint_for_testing<SUI_TEST>(10000, ts::ctx(&mut scenario));
        let coin_b1 = coin::mint_for_testing<USDC_TEST>(10000, ts::ctx(&mut scenario));

        let share1 = vault::deposit(&mut vault, coin_a1, coin_b1, ts::ctx(&mut scenario));
        // Initial sum = 20000. MINIMUM_LIQUIDITY = 1000.
        // User1 receives 20000 - 1000 = 19000 shares. Total shares = 20000.
        assert!(vault::total_shares(&vault) == 20000, 101);
        assert!(vault::share_shares(&share1) == 19000, 102);
        let (bal_a, bal_b) = vault::balances(&vault);
        assert!(bal_a == 10000 && bal_b == 10000, 103);

        ts::return_shared(vault);

        // User 2 Deposit (Proportional share minting)
        ts::next_tx(&mut scenario, USER2);
        let mut vault = ts::take_shared<Vault<SUI_TEST, USDC_TEST>>(&scenario);
        let coin_a2 = coin::mint_for_testing<SUI_TEST>(10000, ts::ctx(&mut scenario));
        let coin_b2 = coin::mint_for_testing<USDC_TEST>(10000, ts::ctx(&mut scenario));

        let mut share2 = vault::deposit(&mut vault, coin_a2, coin_b2, ts::ctx(&mut scenario));
        // Share A = (10000 * 20000) / 10000 = 20000
        // Share B = (10000 * 20000) / 10000 = 20000
        assert!(vault::share_shares(&share2) == 20000, 104);
        assert!(vault::total_shares(&vault) == 40000, 105);
        let (bal_a2, bal_b2) = vault::balances(&vault);
        assert!(bal_a2 == 20000 && bal_b2 == 20000, 106);

        // Split Share: User2 splits 5000 shares out of 20000
        let split_share = vault::split_share(&mut share2, 5000, ts::ctx(&mut scenario));
        assert!(vault::share_shares(&share2) == 15000, 107);
        assert!(vault::share_shares(&split_share) == 5000, 108);

        // Merge Shares: User2 merges split share back
        vault::merge_shares(&mut share2, split_share);
        assert!(vault::share_shares(&share2) == 20000, 109);

        // Withdraw: User2 redeems all 20000 shares
        let (out_a2, out_b2) = vault::withdraw(&mut vault, share2, ts::ctx(&mut scenario));
        assert!(coin::value(&out_a2) == 10000, 110);
        assert!(coin::value(&out_b2) == 10000, 111);
        assert!(vault::total_shares(&vault) == 20000, 112);
        coin::burn_for_testing(out_a2);
        coin::burn_for_testing(out_b2);

        // Withdraw: User1 redeems their 19000 shares
        let (out_a1, out_b1) = vault::withdraw(&mut vault, share1, ts::ctx(&mut scenario));
        // Out A = (19000 * 10000) / 20000 = 9500
        // Out B = (19000 * 10000) / 20000 = 9500
        assert!(coin::value(&out_a1) == 9500, 113);
        assert!(coin::value(&out_b1) == 9500, 114);
        // MINIMUM_LIQUIDITY shares remain locked permanently in total_shares
        assert!(vault::total_shares(&vault) == 1000, 115);
        let (rem_a, rem_b) = vault::balances(&vault);
        assert!(rem_a == 500 && rem_b == 500, 116);

        coin::burn_for_testing(out_a1);
        coin::burn_for_testing(out_b1);
        ts::return_shared(vault);

        ts::end(scenario);
    }

    // --- Test 2: harvest_and_compound ---
    #[test]
    fun test_harvest_and_compound() {
        let mut scenario = ts::begin(ADMIN);
        setup_vault(&mut scenario);

        // User 1 deposits initial liquidity
        ts::next_tx(&mut scenario, USER1);
        let mut vault = ts::take_shared<Vault<SUI_TEST, USDC_TEST>>(&scenario);
        let coin_a = coin::mint_for_testing<SUI_TEST>(10000, ts::ctx(&mut scenario));
        let coin_b = coin::mint_for_testing<USDC_TEST>(10000, ts::ctx(&mut scenario));
        let share1 = vault::deposit(&mut vault, coin_a, coin_b, ts::ctx(&mut scenario));
        ts::return_shared(vault);

        // Operator harvests fees: 1000 SUI_TEST and 2000 USDC_TEST
        ts::next_tx(&mut scenario, ADMIN);
        let mut vault = ts::take_shared<Vault<SUI_TEST, USDC_TEST>>(&scenario);
        let cap = ts::take_from_sender<OperatorCap>(&scenario);

        let fee_coin_a = coin::mint_for_testing<SUI_TEST>(1000, ts::ctx(&mut scenario));
        let fee_coin_b = coin::mint_for_testing<USDC_TEST>(2000, ts::ctx(&mut scenario));

        vault::harvest_and_compound(&cap, &mut vault, fee_coin_a, fee_coin_b, ts::ctx(&mut scenario));

        // 10% fee to treasury: 100 SUI, 200 USDC
        // 90% retained/compounded: 900 SUI, 1800 USDC
        let (bal_a, bal_b) = vault::balances(&vault);
        assert!(bal_a == 10900, 201);
        assert!(bal_b == 11800, 202);

        ts::return_to_sender(&scenario, cap);
        ts::return_shared(vault);

        // Check fee received by treasury
        ts::next_tx(&mut scenario, TREASURY);
        let treasury_coin_a = ts::take_from_sender<Coin<SUI_TEST>>(&scenario);
        let treasury_coin_b = ts::take_from_sender<Coin<USDC_TEST>>(&scenario);
        assert!(coin::value(&treasury_coin_a) == 100, 203);
        assert!(coin::value(&treasury_coin_b) == 200, 204);
        coin::burn_for_testing(treasury_coin_a);
        coin::burn_for_testing(treasury_coin_b);

        // User 1 withdraws shares and verifies increased redemption value
        ts::next_tx(&mut scenario, USER1);
        let mut vault = ts::take_shared<Vault<SUI_TEST, USDC_TEST>>(&scenario);
        let (out_a, out_b) = vault::withdraw(&mut vault, share1, ts::ctx(&mut scenario));
        // User1 had 19000 shares out of 20000 total shares
        // out_a = (19000 * 10900) / 20000 = 10355 (> 10000 initial!)
        // out_b = (19000 * 11800) / 20000 = 11210 (> 10000 initial!)
        assert!(coin::value(&out_a) == 10355, 205);
        assert!(coin::value(&out_b) == 11210, 206);

        coin::burn_for_testing(out_a);
        coin::burn_for_testing(out_b);
        ts::return_shared(vault);

        ts::end(scenario);
    }

    // --- Test 3: Hot-Potato & Dynamic Object Field Custody Flow ---
    #[test]
    fun test_hot_potato_and_dof_custody_flow() {
        let mut scenario = ts::begin(ADMIN);
        setup_vault(&mut scenario);

        // Initial deposit to fund vault balances
        ts::next_tx(&mut scenario, USER1);
        let mut vault = ts::take_shared<Vault<SUI_TEST, USDC_TEST>>(&scenario);
        let coin_a = coin::mint_for_testing<SUI_TEST>(5000, ts::ctx(&mut scenario));
        let coin_b = coin::mint_for_testing<USDC_TEST>(5000, ts::ctx(&mut scenario));
        let share1 = vault::deposit(&mut vault, coin_a, coin_b, ts::ctx(&mut scenario));
        ts::return_shared(vault);

        // Rebalance 1: Seed new position NFT into Vault via start_rebalance + finish_rebalance
        ts::next_tx(&mut scenario, ADMIN);
        let mut vault = ts::take_shared<Vault<SUI_TEST, USDC_TEST>>(&scenario);
        let cap = ts::take_from_sender<OperatorCap>(&scenario);

        assert!(!vault::has_position(&vault), 301);
        assert!(option::is_none(&vault::position_id(&vault)), 302);
        assert!(!vault::is_rebalancing(&vault), 303);

        let (pos_opt1, ret_coin_a1, ret_coin_b1, receipt1) = vault::start_rebalance<SUI_TEST, USDC_TEST, MockPositionNFT>(
            &cap,
            &mut vault,
            ts::ctx(&mut scenario),
        );
        assert!(option::is_none(&pos_opt1), 304);
        option::destroy_none(pos_opt1);
        assert!(vault::is_rebalancing(&vault), 305);
        assert!(coin::value(&ret_coin_a1) == 5000, 306);
        assert!(coin::value(&ret_coin_b1) == 5000, 307);

        let pos1 = new_mock_position(100, 200, 50000, ts::ctx(&mut scenario));
        let pos1_id = object::id(&pos1);

        vault::finish_rebalance<SUI_TEST, USDC_TEST, MockPositionNFT>(
            &mut vault,
            receipt1,
            option::some(pos1),
            ret_coin_a1,
            ret_coin_b1,
            100,
            200,
            1000,
            ts::ctx(&mut scenario),
        );

        assert!(!vault::is_rebalancing(&vault), 308);
        assert!(vault::has_position(&vault), 309);
        assert!(vault::position_id(&vault) == option::some(pos1_id), 310);
        let (tick_l1, tick_u1) = vault::current_ticks(&vault);
        assert!(tick_l1 == 100 && tick_u1 == 200, 311);

        // Verify borrow_position
        let pos1_ref = vault::borrow_position<SUI_TEST, USDC_TEST, MockPositionNFT>(&vault);
        assert!(pos1_ref.liquidity == 50000, 312);

        // Rebalance 2: Swap pos1 for pos2
        let (pos_opt2, ret_coin_a2, ret_coin_b2, receipt2) = vault::start_rebalance<SUI_TEST, USDC_TEST, MockPositionNFT>(
            &cap,
            &mut vault,
            ts::ctx(&mut scenario),
        );
        assert!(option::is_some(&pos_opt2), 313);
        let extracted_pos1 = option::destroy_some(pos_opt2);
        assert!(object::id(&extracted_pos1) == pos1_id, 314);
        destroy_mock_position(extracted_pos1);

        assert!(vault::is_rebalancing(&vault), 315);
        assert!(!vault::has_position(&vault), 316);

        let pos2 = new_mock_position(150, 250, 80000, ts::ctx(&mut scenario));
        let pos2_id = object::id(&pos2);

        vault::finish_rebalance<SUI_TEST, USDC_TEST, MockPositionNFT>(
            &mut vault,
            receipt2,
            option::some(pos2),
            ret_coin_a2,
            ret_coin_b2,
            150,
            250,
            2000,
            ts::ctx(&mut scenario),
        );

        assert!(!vault::is_rebalancing(&vault), 317);
        assert!(vault::has_position(&vault), 318);
        assert!(vault::position_id(&vault) == option::some(pos2_id), 319);
        let (tick_l2, tick_u2) = vault::current_ticks(&vault);
        assert!(tick_l2 == 150 && tick_u2 == 250, 320);

        let pos2_ref = vault::borrow_position<SUI_TEST, USDC_TEST, MockPositionNFT>(&vault);
        assert!(pos2_ref.liquidity == 80000, 321);

        ts::return_to_sender(&scenario, cap);
        ts::return_shared(vault);

        // Clean up share
        ts::next_tx(&mut scenario, USER1);
        let mut vault = ts::take_shared<Vault<SUI_TEST, USDC_TEST>>(&scenario);
        let (c_a, c_b) = vault::withdraw(&mut vault, share1, ts::ctx(&mut scenario));
        coin::burn_for_testing(c_a);
        coin::burn_for_testing(c_b);
        ts::return_shared(vault);

        ts::end(scenario);
    }

    // --- Test 4: deposit_position Seeding Helper ---
    #[test]
    fun test_deposit_position_helper() {
        let mut scenario = ts::begin(ADMIN);
        setup_vault(&mut scenario);

        ts::next_tx(&mut scenario, ADMIN);
        let mut vault = ts::take_shared<Vault<SUI_TEST, USDC_TEST>>(&scenario);
        let cap = ts::take_from_sender<OperatorCap>(&scenario);

        let pos = new_mock_position(50, 150, 25000, ts::ctx(&mut scenario));
        let pos_id = object::id(&pos);

        vault::deposit_position(&cap, &mut vault, pos);
        assert!(vault::has_position(&vault), 401);
        assert!(vault::position_id(&vault) == option::some(pos_id), 402);
        assert!(vault::clmm_position_id(&vault) == option::some(pos_id), 403);

        ts::return_to_sender(&scenario, cap);
        ts::return_shared(vault);
        ts::end(scenario);
    }

    // --- Test 5: Admin Setters & Getters ---
    #[test]
    fun test_admin_setters_and_getters() {
        let mut scenario = ts::begin(ADMIN);
        let (vault_id, admin_id, operator_id) = setup_vault(&mut scenario);

        ts::next_tx(&mut scenario, ADMIN);
        let mut vault = ts::take_shared<Vault<SUI_TEST, USDC_TEST>>(&scenario);
        let admin_cap = ts::take_from_sender<VaultAdminCap>(&scenario);
        let operator_cap = ts::take_from_sender<OperatorCap>(&scenario);

        assert!(vault::admin_cap_vault_id(&admin_cap) == vault_id, 501);
        assert!(vault::operator_cap_vault_id(&operator_cap) == vault_id, 502);
        assert!(object::id(&admin_cap) == admin_id, 503);
        assert!(object::id(&operator_cap) == operator_id, 504);

        assert!(vault::fee_rate(&vault) == 1000, 505);
        assert!(vault::fee_treasury(&vault) == TREASURY, 506);
        assert!(vault::default_fee_bps() == 1000, 507);
        assert!(vault::max_fee_bps() == 2500, 508);
        assert!(vault::minimum_liquidity() == 1000, 509);

        // Update fee rate
        vault::set_fee_rate(&admin_cap, &mut vault, 1500);
        assert!(vault::fee_rate(&vault) == 1500, 510);

        // Update treasury
        vault::set_treasury(&admin_cap, &mut vault, USER1);
        assert!(vault::fee_treasury(&vault) == USER1, 511);

        // Operator records rebalance
        vault::record_rebalance(&operator_cap, &mut vault, 300, 400, 9999, ts::ctx(&mut scenario));
        let (l, u) = vault::current_ticks(&vault);
        assert!(l == 300 && u == 400, 512);

        ts::return_to_sender(&scenario, admin_cap);
        ts::return_to_sender(&scenario, operator_cap);
        ts::return_shared(vault);
        ts::end(scenario);
    }

    // --- Security Negative Tests ---

    // Negative 1: Cross-vault OperatorCap attack fails (EInvalidOperatorCap)
    #[test]
    #[expected_failure(abort_code = blusky_vault::vault::EInvalidOperatorCap)]
    fun test_cross_vault_operator_cap_start_rebalance_fails() {
        let mut scenario = ts::begin(ADMIN);
        let (_v1_id, _a1_id, op1_id) = setup_vault(&mut scenario);
        let (v2_id, _a2_id, _op2_id) = setup_vault(&mut scenario);

        // Operator cap from Vault 1 used on Vault 2
        ts::next_tx(&mut scenario, ADMIN);
        let mut vault2 = ts::take_shared_by_id<Vault<SUI_TEST, USDC_TEST>>(&scenario, v2_id);
        let cap1 = ts::take_from_sender_by_id<OperatorCap>(&scenario, op1_id);

        let (pos_opt, coin_a, coin_b, receipt) = vault::start_rebalance<SUI_TEST, USDC_TEST, MockPositionNFT>(
            &cap1,
            &mut vault2,
            ts::ctx(&mut scenario),
        );

        vault::finish_rebalance<SUI_TEST, USDC_TEST, MockPositionNFT>(
            &mut vault2,
            receipt,
            pos_opt,
            coin_a,
            coin_b,
            0,
            1,
            0,
            ts::ctx(&mut scenario),
        );
        ts::return_to_sender(&scenario, cap1);
        ts::return_shared(vault2);
        ts::end(scenario);
    }

    // Negative 2: Cross-vault OperatorCap on harvest_and_compound fails (EInvalidOperatorCap)
    #[test]
    #[expected_failure(abort_code = blusky_vault::vault::EInvalidOperatorCap)]
    fun test_cross_vault_operator_cap_harvest_fails() {
        let mut scenario = ts::begin(ADMIN);
        let (_v1_id, _a1_id, op1_id) = setup_vault(&mut scenario);
        let (v2_id, _a2_id, _op2_id) = setup_vault(&mut scenario);

        ts::next_tx(&mut scenario, ADMIN);
        let mut vault2 = ts::take_shared_by_id<Vault<SUI_TEST, USDC_TEST>>(&scenario, v2_id);
        let cap1 = ts::take_from_sender_by_id<OperatorCap>(&scenario, op1_id);

        let fee_a = coin::mint_for_testing<SUI_TEST>(100, ts::ctx(&mut scenario));
        let fee_b = coin::mint_for_testing<USDC_TEST>(100, ts::ctx(&mut scenario));

        vault::harvest_and_compound(&cap1, &mut vault2, fee_a, fee_b, ts::ctx(&mut scenario));

        ts::return_to_sender(&scenario, cap1);
        ts::return_shared(vault2);
        ts::end(scenario);
    }

    // Negative 3: Cross-vault VaultAdminCap attack on set_fee_rate fails (EInvalidAdminCap)
    #[test]
    #[expected_failure(abort_code = blusky_vault::vault::EInvalidAdminCap)]
    fun test_cross_vault_admin_cap_set_fee_rate_fails() {
        let mut scenario = ts::begin(ADMIN);
        let (_v1_id, a1_id, _op1_id) = setup_vault(&mut scenario);
        let (v2_id, _a2_id, _op2_id) = setup_vault(&mut scenario);

        ts::next_tx(&mut scenario, ADMIN);
        let mut vault2 = ts::take_shared_by_id<Vault<SUI_TEST, USDC_TEST>>(&scenario, v2_id);
        let admin_cap1 = ts::take_from_sender_by_id<VaultAdminCap>(&scenario, a1_id);

        vault::set_fee_rate(&admin_cap1, &mut vault2, 500);

        ts::return_to_sender(&scenario, admin_cap1);
        ts::return_shared(vault2);
        ts::end(scenario);
    }

    // Negative 4: Cross-vault VaultAdminCap attack on set_treasury fails (EInvalidAdminCap)
    #[test]
    #[expected_failure(abort_code = blusky_vault::vault::EInvalidAdminCap)]
    fun test_cross_vault_admin_cap_set_treasury_fails() {
        let mut scenario = ts::begin(ADMIN);
        let (_v1_id, a1_id, _op1_id) = setup_vault(&mut scenario);
        let (v2_id, _a2_id, _op2_id) = setup_vault(&mut scenario);

        ts::next_tx(&mut scenario, ADMIN);
        let mut vault2 = ts::take_shared_by_id<Vault<SUI_TEST, USDC_TEST>>(&scenario, v2_id);
        let admin_cap1 = ts::take_from_sender_by_id<VaultAdminCap>(&scenario, a1_id);

        vault::set_treasury(&admin_cap1, &mut vault2, USER2);

        ts::return_to_sender(&scenario, admin_cap1);
        ts::return_shared(vault2);
        ts::end(scenario);
    }

    // Negative 5: Passing a VaultShare from Vault A to Vault B's withdraw fails (EInvalidShareVault)
    #[test]
    #[expected_failure(abort_code = blusky_vault::vault::EInvalidShareVault)]
    fun test_cross_vault_withdraw_share_fails() {
        let mut scenario = ts::begin(ADMIN);
        let (v1_id, _a1_id, _op1_id) = setup_vault(&mut scenario);
        let (v2_id, _a2_id, _op2_id) = setup_vault(&mut scenario);

        // Deposit into Vault 1
        ts::next_tx(&mut scenario, USER1);
        let mut vault1 = ts::take_shared_by_id<Vault<SUI_TEST, USDC_TEST>>(&scenario, v1_id);
        let coin_a = coin::mint_for_testing<SUI_TEST>(5000, ts::ctx(&mut scenario));
        let coin_b = coin::mint_for_testing<USDC_TEST>(5000, ts::ctx(&mut scenario));
        let share_v1 = vault::deposit(&mut vault1, coin_a, coin_b, ts::ctx(&mut scenario));
        ts::return_shared(vault1);

        // Try to redeem share_v1 in Vault 2
        ts::next_tx(&mut scenario, USER1);
        let mut vault2 = ts::take_shared_by_id<Vault<SUI_TEST, USDC_TEST>>(&scenario, v2_id);
        let (out_a, out_b) = vault::withdraw(&mut vault2, share_v1, ts::ctx(&mut scenario));

        coin::burn_for_testing(out_a);
        coin::burn_for_testing(out_b);
        ts::return_shared(vault2);
        ts::end(scenario);
    }

    // Negative 6: Setting fee > MAX_FEE_BPS fails (EFeeRateTooHigh)
    #[test]
    #[expected_failure(abort_code = blusky_vault::vault::EFeeRateTooHigh)]
    fun test_set_fee_rate_too_high_fails() {
        let mut scenario = ts::begin(ADMIN);
        setup_vault(&mut scenario);

        ts::next_tx(&mut scenario, ADMIN);
        let mut vault = ts::take_shared<Vault<SUI_TEST, USDC_TEST>>(&scenario);
        let admin_cap = ts::take_from_sender<VaultAdminCap>(&scenario);

        // MAX_FEE_BPS is 2500; 2501 must abort
        vault::set_fee_rate(&admin_cap, &mut vault, 2501);

        ts::return_to_sender(&scenario, admin_cap);
        ts::return_shared(vault);
        ts::end(scenario);
    }

    // Negative 7: Creating vault with fee > MAX_FEE_BPS fails (EFeeRateTooHigh)
    #[test]
    #[expected_failure(abort_code = blusky_vault::vault::EFeeRateTooHigh)]
    fun test_create_vault_fee_too_high_fails() {
        let mut scenario = ts::begin(ADMIN);
        ts::next_tx(&mut scenario, ADMIN);
        vault::create_vault<SUI_TEST, USDC_TEST>(3000, TREASURY, ts::ctx(&mut scenario));
        ts::end(scenario);
    }

    // Negative 8: Double start_rebalance fails (ERebalanceInProgress)
    #[test]
    #[expected_failure(abort_code = blusky_vault::vault::ERebalanceInProgress)]
    fun test_double_start_rebalance_fails() {
        let mut scenario = ts::begin(ADMIN);
        setup_vault(&mut scenario);

        ts::next_tx(&mut scenario, ADMIN);
        let mut vault = ts::take_shared<Vault<SUI_TEST, USDC_TEST>>(&scenario);
        let cap = ts::take_from_sender<OperatorCap>(&scenario);

        let (pos_opt1, coin_a1, coin_b1, receipt1) = vault::start_rebalance<SUI_TEST, USDC_TEST, MockPositionNFT>(
            &cap,
            &mut vault,
            ts::ctx(&mut scenario),
        );

        let (pos_opt2, coin_a2, coin_b2, receipt2) = vault::start_rebalance<SUI_TEST, USDC_TEST, MockPositionNFT>(
            &cap,
            &mut vault,
            ts::ctx(&mut scenario),
        );

        vault::finish_rebalance<SUI_TEST, USDC_TEST, MockPositionNFT>(
            &mut vault,
            receipt1,
            pos_opt1,
            coin_a1,
            coin_b1,
            0,
            1,
            0,
            ts::ctx(&mut scenario),
        );
        vault::finish_rebalance<SUI_TEST, USDC_TEST, MockPositionNFT>(
            &mut vault,
            receipt2,
            pos_opt2,
            coin_a2,
            coin_b2,
            0,
            1,
            0,
            ts::ctx(&mut scenario),
        );

        ts::return_to_sender(&scenario, cap);
        ts::return_shared(vault);
        ts::end(scenario);
    }

    // Negative 9: Deposit below minimum liquidity on initial deposit fails (EInsufficientLiquidity)
    #[test]
    #[expected_failure(abort_code = blusky_vault::vault::EInsufficientLiquidity)]
    fun test_deposit_below_minimum_liquidity_fails() {
        let mut scenario = ts::begin(ADMIN);
        setup_vault(&mut scenario);

        ts::next_tx(&mut scenario, USER1);
        let mut vault = ts::take_shared<Vault<SUI_TEST, USDC_TEST>>(&scenario);
        // MINIMUM_LIQUIDITY is 1000. 500 + 500 = 1000 which is NOT > 1000
        let coin_a = coin::mint_for_testing<SUI_TEST>(500, ts::ctx(&mut scenario));
        let coin_b = coin::mint_for_testing<USDC_TEST>(500, ts::ctx(&mut scenario));

        let share = vault::deposit(&mut vault, coin_a, coin_b, ts::ctx(&mut scenario));

        let (out_a, out_b) = vault::withdraw(&mut vault, share, ts::ctx(&mut scenario));
        coin::burn_for_testing(out_a);
        coin::burn_for_testing(out_b);
        ts::return_shared(vault);
        ts::end(scenario);
    }

    // Negative 10: Deposit while rebalancing fails (ERebalanceInProgress)
    #[test]
    #[expected_failure(abort_code = blusky_vault::vault::ERebalanceInProgress)]
    fun test_deposit_while_rebalancing_fails() {
        let mut scenario = ts::begin(ADMIN);
        setup_vault(&mut scenario);

        ts::next_tx(&mut scenario, ADMIN);
        let mut vault = ts::take_shared<Vault<SUI_TEST, USDC_TEST>>(&scenario);
        let cap = ts::take_from_sender<OperatorCap>(&scenario);

        let (pos_opt, coin_a, coin_b, receipt) = vault::start_rebalance<SUI_TEST, USDC_TEST, MockPositionNFT>(
            &cap,
            &mut vault,
            ts::ctx(&mut scenario),
        );

        // Attempt deposit while is_rebalancing is true
        let dep_a = coin::mint_for_testing<SUI_TEST>(5000, ts::ctx(&mut scenario));
        let dep_b = coin::mint_for_testing<USDC_TEST>(5000, ts::ctx(&mut scenario));
        let share = vault::deposit(&mut vault, dep_a, dep_b, ts::ctx(&mut scenario));

        vault::finish_rebalance<SUI_TEST, USDC_TEST, MockPositionNFT>(
            &mut vault,
            receipt,
            pos_opt,
            coin_a,
            coin_b,
            0,
            1,
            0,
            ts::ctx(&mut scenario),
        );
        let (out_a, out_b) = vault::withdraw(&mut vault, share, ts::ctx(&mut scenario));
        coin::burn_for_testing(out_a);
        coin::burn_for_testing(out_b);
        ts::return_to_sender(&scenario, cap);
        ts::return_shared(vault);
        ts::end(scenario);
    }

    // Negative 11: Withdraw while rebalancing fails (ERebalanceInProgress)
    #[test]
    #[expected_failure(abort_code = blusky_vault::vault::ERebalanceInProgress)]
    fun test_withdraw_while_rebalancing_fails() {
        let mut scenario = ts::begin(ADMIN);
        setup_vault(&mut scenario);

        // Initial deposit
        ts::next_tx(&mut scenario, USER1);
        let mut vault = ts::take_shared<Vault<SUI_TEST, USDC_TEST>>(&scenario);
        let dep_a = coin::mint_for_testing<SUI_TEST>(5000, ts::ctx(&mut scenario));
        let dep_b = coin::mint_for_testing<USDC_TEST>(5000, ts::ctx(&mut scenario));
        let share = vault::deposit(&mut vault, dep_a, dep_b, ts::ctx(&mut scenario));
        ts::return_shared(vault);

        // Operator starts rebalance
        ts::next_tx(&mut scenario, ADMIN);
        let mut vault = ts::take_shared<Vault<SUI_TEST, USDC_TEST>>(&scenario);
        let cap = ts::take_from_sender<OperatorCap>(&scenario);

        let (pos_opt, coin_a, coin_b, receipt) = vault::start_rebalance<SUI_TEST, USDC_TEST, MockPositionNFT>(
            &cap,
            &mut vault,
            ts::ctx(&mut scenario),
        );

        // User attempts withdraw while is_rebalancing is true
        let (out_a, out_b) = vault::withdraw(&mut vault, share, ts::ctx(&mut scenario));

        vault::finish_rebalance<SUI_TEST, USDC_TEST, MockPositionNFT>(
            &mut vault,
            receipt,
            pos_opt,
            coin_a,
            coin_b,
            0,
            1,
            0,
            ts::ctx(&mut scenario),
        );
        coin::burn_for_testing(out_a);
        coin::burn_for_testing(out_b);
        ts::return_to_sender(&scenario, cap);
        ts::return_shared(vault);
        ts::end(scenario);
    }

    // Negative 12: Finish rebalance with invalid ticks (lower >= upper) fails (EInvalidTicks)
    #[test]
    #[expected_failure(abort_code = blusky_vault::vault::EInvalidTicks)]
    fun test_finish_rebalance_invalid_ticks_fails() {
        let mut scenario = ts::begin(ADMIN);
        setup_vault(&mut scenario);

        ts::next_tx(&mut scenario, ADMIN);
        let mut vault = ts::take_shared<Vault<SUI_TEST, USDC_TEST>>(&scenario);
        let cap = ts::take_from_sender<OperatorCap>(&scenario);

        let (pos_opt, coin_a, coin_b, receipt) = vault::start_rebalance<SUI_TEST, USDC_TEST, MockPositionNFT>(
            &cap,
            &mut vault,
            ts::ctx(&mut scenario),
        );

        // lower_tick (200) >= upper_tick (100) must abort
        vault::finish_rebalance<SUI_TEST, USDC_TEST, MockPositionNFT>(
            &mut vault,
            receipt,
            pos_opt,
            coin_a,
            coin_b,
            200,
            100,
            0,
            ts::ctx(&mut scenario),
        );

        ts::return_to_sender(&scenario, cap);
        ts::return_shared(vault);
        ts::end(scenario);
    }

    // Negative 13: Split share with zero shares fails (EZeroShares)
    #[test]
    #[expected_failure(abort_code = blusky_vault::vault::EZeroShares)]
    fun test_split_share_zero_shares_fails() {
        let mut scenario = ts::begin(ADMIN);
        setup_vault(&mut scenario);

        ts::next_tx(&mut scenario, USER1);
        let mut vault = ts::take_shared<Vault<SUI_TEST, USDC_TEST>>(&scenario);
        let coin_a = coin::mint_for_testing<SUI_TEST>(5000, ts::ctx(&mut scenario));
        let coin_b = coin::mint_for_testing<USDC_TEST>(5000, ts::ctx(&mut scenario));
        let mut share = vault::deposit(&mut vault, coin_a, coin_b, ts::ctx(&mut scenario));

        let split = vault::split_share(&mut share, 0, ts::ctx(&mut scenario));

        vault::merge_shares(&mut share, split);
        let (out_a, out_b) = vault::withdraw(&mut vault, share, ts::ctx(&mut scenario));
        coin::burn_for_testing(out_a);
        coin::burn_for_testing(out_b);
        ts::return_shared(vault);
        ts::end(scenario);
    }

    // Negative 14: Split share with split_shares >= total held fails (EInsufficientShares)
    #[test]
    #[expected_failure(abort_code = blusky_vault::vault::EInsufficientShares)]
    fun test_split_share_insufficient_shares_fails() {
        let mut scenario = ts::begin(ADMIN);
        setup_vault(&mut scenario);

        ts::next_tx(&mut scenario, USER1);
        let mut vault = ts::take_shared<Vault<SUI_TEST, USDC_TEST>>(&scenario);
        let coin_a = coin::mint_for_testing<SUI_TEST>(5000, ts::ctx(&mut scenario));
        let coin_b = coin::mint_for_testing<USDC_TEST>(5000, ts::ctx(&mut scenario));
        let mut share = vault::deposit(&mut vault, coin_a, coin_b, ts::ctx(&mut scenario));

        let total = vault::share_shares(&share);
        // Attempting to split equal to or greater than available
        let split = vault::split_share(&mut share, total, ts::ctx(&mut scenario));

        vault::merge_shares(&mut share, split);
        let (out_a, out_b) = vault::withdraw(&mut vault, share, ts::ctx(&mut scenario));
        coin::burn_for_testing(out_a);
        coin::burn_for_testing(out_b);
        ts::return_shared(vault);
        ts::end(scenario);
    }

    // Negative 15: Merge shares from different vaults fails (EInvalidShareVault)
    #[test]
    #[expected_failure(abort_code = blusky_vault::vault::EInvalidShareVault)]
    fun test_merge_shares_cross_vault_fails() {
        let mut scenario = ts::begin(ADMIN);
        let (v1_id, _a1_id, _op1_id) = setup_vault(&mut scenario);
        let (v2_id, _a2_id, _op2_id) = setup_vault(&mut scenario);

        // User 1 deposits into Vault 1
        ts::next_tx(&mut scenario, USER1);
        let mut vault1 = ts::take_shared_by_id<Vault<SUI_TEST, USDC_TEST>>(&scenario, v1_id);
        let c_a1 = coin::mint_for_testing<SUI_TEST>(5000, ts::ctx(&mut scenario));
        let c_b1 = coin::mint_for_testing<USDC_TEST>(5000, ts::ctx(&mut scenario));
        let mut share1 = vault::deposit(&mut vault1, c_a1, c_b1, ts::ctx(&mut scenario));
        ts::return_shared(vault1);

        // User 1 deposits into Vault 2
        ts::next_tx(&mut scenario, USER1);
        let mut vault2 = ts::take_shared_by_id<Vault<SUI_TEST, USDC_TEST>>(&scenario, v2_id);
        let c_a2 = coin::mint_for_testing<SUI_TEST>(5000, ts::ctx(&mut scenario));
        let c_b2 = coin::mint_for_testing<USDC_TEST>(5000, ts::ctx(&mut scenario));
        let share2 = vault::deposit(&mut vault2, c_a2, c_b2, ts::ctx(&mut scenario));
        ts::return_shared(vault2);

        // Attempt cross-vault merge
        vault::merge_shares(&mut share1, share2);

        ts::next_tx(&mut scenario, USER1);
        let mut vault1 = ts::take_shared_by_id<Vault<SUI_TEST, USDC_TEST>>(&scenario, v1_id);
        let (out_a, out_b) = vault::withdraw(&mut vault1, share1, ts::ctx(&mut scenario));
        coin::burn_for_testing(out_a);
        coin::burn_for_testing(out_b);
        ts::return_shared(vault1);
        ts::end(scenario);
    }

    // Negative 16: Finish rebalance with cross-vault receipt fails (EInvalidReceipt)
    #[test]
    #[expected_failure(abort_code = blusky_vault::vault::EInvalidReceipt)]
    fun test_finish_rebalance_cross_vault_receipt_fails() {
        let mut scenario = ts::begin(ADMIN);
        let (v1_id, _a1_id, op1_id) = setup_vault(&mut scenario);
        let (v2_id, _a2_id, op2_id) = setup_vault(&mut scenario);

        // Start rebalance on Vault 1 -> Receipt for Vault 1
        ts::next_tx(&mut scenario, ADMIN);
        let mut vault1 = ts::take_shared_by_id<Vault<SUI_TEST, USDC_TEST>>(&scenario, v1_id);
        let cap1 = ts::take_from_sender_by_id<OperatorCap>(&scenario, op1_id);

        let (pos_opt1, coin_a1, coin_b1, receipt1) = vault::start_rebalance<SUI_TEST, USDC_TEST, MockPositionNFT>(
            &cap1,
            &mut vault1,
            ts::ctx(&mut scenario),
        );

        // Start rebalance on Vault 2 to make it is_rebalancing = true
        let mut vault2 = ts::take_shared_by_id<Vault<SUI_TEST, USDC_TEST>>(&scenario, v2_id);
        let cap2 = ts::take_from_sender_by_id<OperatorCap>(&scenario, op2_id);
        let (pos_opt2, coin_a2, coin_b2, receipt2) = vault::start_rebalance<SUI_TEST, USDC_TEST, MockPositionNFT>(
            &cap2,
            &mut vault2,
            ts::ctx(&mut scenario),
        );

        // Try to finish rebalance on Vault 2 using receipt1 (which belongs to Vault 1) -> EInvalidReceipt
        vault::finish_rebalance<SUI_TEST, USDC_TEST, MockPositionNFT>(
            &mut vault2,
            receipt1,
            pos_opt1,
            coin_a1,
            coin_b1,
            0,
            1,
            0,
            ts::ctx(&mut scenario),
        );

        vault::finish_rebalance<SUI_TEST, USDC_TEST, MockPositionNFT>(
            &mut vault2,
            receipt2,
            pos_opt2,
            coin_a2,
            coin_b2,
            0,
            1,
            0,
            ts::ctx(&mut scenario),
        );

        ts::return_to_sender(&scenario, cap1);
        ts::return_to_sender(&scenario, cap2);
        ts::return_shared(vault1);
        ts::return_shared(vault2);
        ts::end(scenario);
    }

    // Negative 17: Zero deposit fails (EZeroDeposit)
    #[test]
    #[expected_failure(abort_code = blusky_vault::vault::EZeroDeposit)]
    fun test_zero_deposit_fails() {
        let mut scenario = ts::begin(ADMIN);
        setup_vault(&mut scenario);

        ts::next_tx(&mut scenario, USER1);
        let mut vault = ts::take_shared<Vault<SUI_TEST, USDC_TEST>>(&scenario);
        let coin_a = coin::mint_for_testing<SUI_TEST>(0, ts::ctx(&mut scenario));
        let coin_b = coin::mint_for_testing<USDC_TEST>(0, ts::ctx(&mut scenario));

        let share = vault::deposit(&mut vault, coin_a, coin_b, ts::ctx(&mut scenario));

        let (out_a, out_b) = vault::withdraw(&mut vault, share, ts::ctx(&mut scenario));
        coin::burn_for_testing(out_a);
        coin::burn_for_testing(out_b);
        ts::return_shared(vault);
        ts::end(scenario);
    }
}
