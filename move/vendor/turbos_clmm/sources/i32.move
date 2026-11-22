module turbos_clmm::i32 {
    public struct I32 has copy, drop, store {
        bits: u32,
    }

    public fun zero(): I32 {
        I32 { bits: 0 }
    }
}

