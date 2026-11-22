#[allow(unused_field)]
module cetusclmm::position {
    use integer_mate::i32::I32;

    public struct Position has key, store {
        id: UID,
        pool: ID,
        liquidity: u128,
        dummy: vector<I32>,
    }

    public fun pool_id(pos: &Position): ID {
        pos.pool
    }

    public fun liquidity(pos: &Position): u128 {
        pos.liquidity
    }

    #[test_only]
    public fun new_for_testing(pool: ID, liquidity: u128, ctx: &mut TxContext): Position {
        Position { id: object::new(ctx), pool, liquidity, dummy: vector[] }
    }

    public(package) fun add_liq(pos: &mut Position, delta: u128) {
        pos.liquidity = pos.liquidity + delta;
    }

    public(package) fun sub_liq(pos: &mut Position, delta: u128) {
        pos.liquidity = pos.liquidity - delta;
    }

    #[test_only]
    public fun destroy_for_testing(pos: Position) {
        let Position { id, pool: _, liquidity: _, dummy: _ } = pos;
        object::delete(id);
    }
}
