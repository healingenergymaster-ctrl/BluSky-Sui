// move/sources/events.move
// Event Definitions for BluSky-Sui On-Chain Liquidity Vaults

module blusky_vault::events {
    use sui::object::ID;

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
}
