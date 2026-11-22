module turbos_clmm::position_nft {
    public struct TurbosPositionNFT has key, store {
        id: UID,
        pool_id: ID,
        position_id: ID,
    }

    public fun pool_id(nft: &TurbosPositionNFT): ID {
        nft.pool_id
    }

    public fun position_id(nft: &TurbosPositionNFT): ID {
        nft.position_id
    }

    #[test_only]
    public fun new_for_testing(pool_id: ID, position_id: ID, ctx: &mut TxContext): TurbosPositionNFT {
        TurbosPositionNFT { id: object::new(ctx), pool_id, position_id }
    }

    #[test_only]
    public fun destroy_for_testing(nft: TurbosPositionNFT) {
        let TurbosPositionNFT { id, pool_id: _, position_id: _ } = nft;
        object::delete(id);
    }
}

