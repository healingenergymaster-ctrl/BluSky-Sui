module move_stl::option_u64 {
    public struct OptionU64 has copy, drop, store {
        is_none: bool,
        v: u64,
    }
}

