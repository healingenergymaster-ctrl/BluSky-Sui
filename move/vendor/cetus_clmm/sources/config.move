module cetusclmm::config {
    public struct GlobalConfig has key, store {
        id: UID,
    }

    #[test_only]
    public fun new_for_testing(ctx: &mut TxContext): GlobalConfig {
        GlobalConfig { id: object::new(ctx) }
    }

    #[test_only]
    public fun destroy_for_testing(cfg: GlobalConfig) {
        let GlobalConfig { id } = cfg;
        object::delete(id);
    }
}

