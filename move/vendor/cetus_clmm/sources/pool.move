#[allow(unused_field, unused_type_parameter)]
module cetusclmm::pool {
    use sui::balance::{Self, Balance};
    use sui::clock::Clock;
    use cetusclmm::config::GlobalConfig;
    use cetusclmm::position::{Self, Position};

    public struct Pool<phantom CoinTypeA, phantom CoinTypeB> has key, store {
        id: UID,
        bal_a: Balance<CoinTypeA>,
        bal_b: Balance<CoinTypeB>,
    }

    public struct AddLiquidityReceipt<phantom CoinTypeA, phantom CoinTypeB> {
        pool_id: ID,
        amount_a: u64,
        amount_b: u64,
    }

    public fun add_liquidity_fix_coin<CoinTypeA, CoinTypeB>(
        _config: &GlobalConfig,
        pool: &mut Pool<CoinTypeA, CoinTypeB>,
        position_nft: &mut Position,
        amount: u64,
        fix_amount_a: bool,
        _clock: &Clock
    ): AddLiquidityReceipt<CoinTypeA, CoinTypeB> {
        // Test mock: 1:1 ratio and delta liquidity = amount * 2
        let _ = fix_amount_a;
        position::add_liq(position_nft, (amount as u128) * 2);
        AddLiquidityReceipt<CoinTypeA, CoinTypeB> {
            pool_id: object::id(pool),
            amount_a: amount,
            amount_b: amount,
        }
    }

    public fun add_liquidity_pay_amount<CoinTypeA, CoinTypeB>(
        receipt: &AddLiquidityReceipt<CoinTypeA, CoinTypeB>
    ): (u64, u64) {
        (receipt.amount_a, receipt.amount_b)
    }

    public fun repay_add_liquidity<CoinTypeA, CoinTypeB>(
        _config: &GlobalConfig,
        pool: &mut Pool<CoinTypeA, CoinTypeB>,
        balance_a: Balance<CoinTypeA>,
        balance_b: Balance<CoinTypeB>,
        receipt: AddLiquidityReceipt<CoinTypeA, CoinTypeB>
    ) {
        let AddLiquidityReceipt { pool_id, amount_a: _, amount_b: _ } = receipt;
        assert!(pool_id == object::id(pool), 1);
        balance::join(&mut pool.bal_a, balance_a);
        balance::join(&mut pool.bal_b, balance_b);
    }

    public fun remove_liquidity<CoinTypeA, CoinTypeB>(
        _config: &GlobalConfig,
        pool: &mut Pool<CoinTypeA, CoinTypeB>,
        position_nft: &mut Position,
        delta_liquidity: u128,
        _clock: &Clock,
    ): (Balance<CoinTypeA>, Balance<CoinTypeB>) {
        let total_liq = position::liquidity(position_nft);
        assert!(total_liq >= delta_liquidity, 2);
        let cur_a = balance::value(&pool.bal_a);
        let cur_b = balance::value(&pool.bal_b);
        let out_a = (((delta_liquidity) * (cur_a as u128)) / total_liq) as u64;
        let out_b = (((delta_liquidity) * (cur_b as u128)) / total_liq) as u64;
        position::sub_liq(position_nft, delta_liquidity);
        (
            balance::split(&mut pool.bal_a, out_a),
            balance::split(&mut pool.bal_b, out_b),
        )
    }

    #[test_only]
    public fun new_for_testing<CoinTypeA, CoinTypeB>(
        bal_a: Balance<CoinTypeA>,
        bal_b: Balance<CoinTypeB>,
        ctx: &mut TxContext
    ): Pool<CoinTypeA, CoinTypeB> {
        Pool { id: object::new(ctx), bal_a, bal_b }
    }

    #[test_only]
    public fun destroy_for_testing<CoinTypeA, CoinTypeB>(pool: Pool<CoinTypeA, CoinTypeB>) {
        let Pool { id, bal_a, bal_b } = pool;
        balance::destroy_for_testing(bal_a);
        balance::destroy_for_testing(bal_b);
        object::delete(id);
    }
}

