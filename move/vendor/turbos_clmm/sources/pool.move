#[allow(unused_field, unused_type_parameter)]
module turbos_clmm::pool {
    use sui::balance::{Self, Balance};

    public struct Versioned has key, store {
        id: UID,
        version: u64,
    }

    public struct Pool<phantom CoinTypeA, phantom CoinTypeB, phantom FeeType> has key, store {
        id: UID,
        bal_a: Balance<CoinTypeA>,
        bal_b: Balance<CoinTypeB>,
    }

    #[test_only]
    public fun new_versioned_for_testing(ctx: &mut TxContext): Versioned {
        Versioned { id: object::new(ctx), version: 1 }
    }

    #[test_only]
    public fun destroy_versioned_for_testing(v: Versioned) {
        let Versioned { id, version: _ } = v;
        object::delete(id);
    }

    #[test_only]
    public fun new_for_testing<CoinTypeA, CoinTypeB, FeeType>(
        bal_a: Balance<CoinTypeA>,
        bal_b: Balance<CoinTypeB>,
        ctx: &mut TxContext
    ): Pool<CoinTypeA, CoinTypeB, FeeType> {
        Pool { id: object::new(ctx), bal_a, bal_b }
    }

    public(package) fun deposit_balances<CoinTypeA, CoinTypeB, FeeType>(
        pool: &mut Pool<CoinTypeA, CoinTypeB, FeeType>,
        a: Balance<CoinTypeA>,
        b: Balance<CoinTypeB>
    ) {
        balance::join(&mut pool.bal_a, a);
        balance::join(&mut pool.bal_b, b);
    }

    public(package) fun take_pro_rata<CoinTypeA, CoinTypeB, FeeType>(
        pool: &mut Pool<CoinTypeA, CoinTypeB, FeeType>,
        delta_liq: u128,
        total_liq: u128,
        ctx: &mut TxContext
    ): (sui::coin::Coin<CoinTypeA>, sui::coin::Coin<CoinTypeB>) {
        let cur_a = balance::value(&pool.bal_a);
        let cur_b = balance::value(&pool.bal_b);
        let out_a = ((delta_liq * (cur_a as u128)) / total_liq) as u64;
        let out_b = ((delta_liq * (cur_b as u128)) / total_liq) as u64;
        (
            sui::coin::from_balance(balance::split(&mut pool.bal_a, out_a), ctx),
            sui::coin::from_balance(balance::split(&mut pool.bal_b, out_b), ctx),
        )
    }

    #[test_only]
    public fun destroy_for_testing<CoinTypeA, CoinTypeB, FeeType>(pool: Pool<CoinTypeA, CoinTypeB, FeeType>) {
        let Pool { id, bal_a, bal_b } = pool;
        balance::destroy_for_testing(bal_a);
        balance::destroy_for_testing(bal_b);
        object::delete(id);
    }
}
