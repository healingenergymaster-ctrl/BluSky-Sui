module turbos_clmm::position_manager {
    use sui::clock::Clock;
    use sui::coin::{Self, Coin};
    use sui::table::{Self, Table};
    use turbos_clmm::i32::{Self, I32};
    use turbos_clmm::pool::{Self, Pool, Versioned};
    use turbos_clmm::position_nft::{TurbosPositionNFT};

    public struct Positions has key, store {
        id: UID,
        liq: Table<address, u128>,
    }

    public fun get_position_info(
        positions: &Positions,
        nft_address: address,
    ): (I32, I32, u128) {
        let l = *table::borrow(&positions.liq, nft_address);
        (i32::zero(), i32::zero(), l)
    }

    #[allow(unused_type_parameter)]
    public fun increase_liquidity_with_return_<CoinTypeA, CoinTypeB, FeeType>(
        pool: &mut Pool<CoinTypeA, CoinTypeB, FeeType>,
        positions: &mut Positions,
        mut coins_a: vector<Coin<CoinTypeA>>,
        mut coins_b: vector<Coin<CoinTypeB>>,
        nft: &mut TurbosPositionNFT,
        amount_a_desired: u64,
        amount_b_desired: u64,
        _amount_a_min: u64,
        _amount_b_min: u64,
        _deadline: u64,
        _clock: &Clock,
        _versioned: &Versioned,
        ctx: &mut TxContext
    ): (Coin<CoinTypeA>, Coin<CoinTypeB>) {
        let mut ca = coin::zero<CoinTypeA>(ctx);
        let mut cb = coin::zero<CoinTypeB>(ctx);
        while (!vector::is_empty(&coins_a)) {
            coin::join(&mut ca, vector::pop_back(&mut coins_a));
        };
        while (!vector::is_empty(&coins_b)) {
            coin::join(&mut cb, vector::pop_back(&mut coins_b));
        };
        vector::destroy_empty(coins_a);
        vector::destroy_empty(coins_b);

        let take_a = if (coin::value(&ca) >= amount_a_desired) { amount_a_desired } else { coin::value(&ca) };
        let take_b = if (coin::value(&cb) >= amount_b_desired) { amount_b_desired } else { coin::value(&cb) };
        let use_min = if (take_a < take_b) { take_a } else { take_b };
        let used_a = coin::split(&mut ca, use_min, ctx);
        let used_b = coin::split(&mut cb, use_min, ctx);
        pool::deposit_balances(pool, coin::into_balance(used_a), coin::into_balance(used_b));

        let nft_addr = object::id_to_address(&object::id(nft));
        let cur_liq = table::borrow_mut(&mut positions.liq, nft_addr);
        *cur_liq = *cur_liq + (use_min as u128) * 2;
        (ca, cb)
    }

    #[allow(unused_type_parameter)]
    public fun decrease_liquidity_with_return_<CoinTypeA, CoinTypeB, FeeType>(
        pool: &mut Pool<CoinTypeA, CoinTypeB, FeeType>,
        positions: &mut Positions,
        nft: &mut TurbosPositionNFT,
        liquidity: u128,
        _amount_a_min: u64,
        _amount_b_min: u64,
        _deadline: u64,
        _clock: &Clock,
        _versioned: &Versioned,
        ctx: &mut TxContext
    ): (Coin<CoinTypeA>, Coin<CoinTypeB>) {
        let nft_addr = object::id_to_address(&object::id(nft));
        let cur_liq = table::borrow_mut(&mut positions.liq, nft_addr);
        let total_liq = *cur_liq;
        assert!(total_liq >= liquidity, 2);
        let (out_a, out_b) = pool::take_pro_rata(pool, liquidity, total_liq, ctx);
        *cur_liq = total_liq - liquidity;
        (out_a, out_b)
    }

    #[test_only]
    public fun new_for_testing(ctx: &mut TxContext): Positions {
        Positions { id: object::new(ctx), liq: table::new(ctx) }
    }

    #[test_only]
    public fun register_for_testing(positions: &mut Positions, nft: &TurbosPositionNFT, liq: u128) {
        table::add(&mut positions.liq, object::id_to_address(&object::id(nft)), liq);
    }

    #[test_only]
    public fun destroy_for_testing(positions: Positions) {
        let Positions { id, liq } = positions;
        table::drop(liq);
        object::delete(id);
    }
}

