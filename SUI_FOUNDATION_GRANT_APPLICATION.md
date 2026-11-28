# Sui Foundation Developer Grant & Security Audit Support Application

**Project Name:** BluSky-Sui  
**Live Mainnet dApp:** [https://app.bluskysui.xyz](https://app.bluskysui.xyz)  
**Category:** DeFi Infrastructure / Concentrated Liquidity & Delta-Neutral Yield Vaults  
**Requested Support:** $75,000 USD Milestone-Based Grant *(or Security Audit Subsidy / Co-Funded Tier-1 Move Audit + Mainnet Scaling Support)*  
**Project Status:** Live Sui Mainnet Production Pilot (Move v4 Shared Vaults, Dual-DEX Cetus & Turbos, Live Bluefin Pro Hedging)  
**Primary Ecosystem Partners:** Cetus Protocol, Turbos Finance, Bluefin Exchange  

---

## 1. Executive Summary

Concentrated Liquidity Market Makers (CLMMs) on Sui consistently generate some of the highest trading-fee yields in DeFi, yet **price drift frequently pushes static LP ranges out of bounds**, halting fee accrual and amplifying impermanent loss.

**BluSky-Sui** is an automated concentrated liquidity and delta-neutral yield protocol built natively for Sui. It continuously monitors live CLMM ranges across **Cetus Protocol (`0.05%`)** and **Turbos Finance (`0.05%`)**, executes atomic single-PTB tick re-centering with slippage protection, allows permissionless single-signer **USDC Zap-In** and **1-Click 100% USDC Zap-Out** withdrawals, and pairs active spot SUI delta with live **Bluefin Pro (`SUI-PERP`) 1x short hedging**.

Using **Programmable Transaction Blocks (PTBs)**, **Mysticeti sub-second finality**, and the **Move 2024 object model (`VaultShare<CoinA, CoinB>`)**, BluSky-Sui replaces fragmented multi-transaction rebalancing with single-block atomic execution. The protocol is **live on Sui Mainnet today** at [app.bluskysui.xyz](https://app.bluskysui.xyz) running Move **v4** as an active pilot ahead of an external Tier-1 Move security audit and public TVL scaling.

---

## 2. Live Sui Mainnet Deployment & Verifiable On-Chain Proofs

Unlike conceptual proposals, BluSky-Sui is actively deployed on **Sui Mainnet** (`Move v4`) with live Cetus 0.05%, Turbos 0.05%, and Bluefin Pro integrations.

### A. Published Mainnet Contracts & Live Vaults

| Role | On-Chain Address / ID | Explorer |
| :--- | :--- | :--- |
| **Move Package (`VAULT_PACKAGE_ID`, Original)** | `0x5ec95b86aec0b1b3b3277383713ee1815a49303b16216d90688dbda5c8cb710a` | [SuiVision Package ↗](https://suivision.xyz/package/0x5ec95b86aec0b1b3b3277383713ee1815a49303b16216d90688dbda5c8cb710a) |
| **Upgraded Call Package (Move v4)** | `0x0e6405f42a9e91d3af5b3f8ddcb6ee66558afaba471233d3e61662fb17c40209` | [SuiVision v4 Package ↗](https://suivision.xyz/package/0x0e6405f42a9e91d3af5b3f8ddcb6ee66558afaba471233d3e61662fb17c40209) |
| **Cetus 0.05% Vault (`cetus005`)** | `0xa6ef82cd00e4cbea40bcdbbe2d557590d73dc0c332478ac43ba6e13ea80441ae` | [SuiVision Vault ↗](https://suivision.xyz/object/0xa6ef82cd00e4cbea40bcdbbe2d557590d73dc0c332478ac43ba6e13ea80441ae) |
| **Turbos 0.05% Vault (`turbos005`)** | `0x08c282087feee1850d6b66c0ceb2e6ad0885a58413d1bd561df19fd851aaac27` | [SuiVision Vault ↗](https://suivision.xyz/object/0x08c282087feee1850d6b66c0ceb2e6ad0885a58413d1bd561df19fd851aaac27) |
| **Protocol Fee Treasury (`@bluskysui` / `bluskysui.sui`)** | `0xa81ad397c3aadae2ddcfde5cef96aa21d4f445c918f8d819c5ea757aafa8f6db` | [SuiVision Account ↗](https://suivision.xyz/account/0xa81ad397c3aadae2ddcfde5cef96aa21d4f445c918f8d819c5ea757aafa8f6db) |
| **Mainnet `UpgradeCap`** | `0x5f63c83a5db8ae679465e946e7fab8275378a36c1eaf3aba41e0f5a095dddd74` | [SuiVision Object ↗](https://suivision.xyz/object/0x5f63c83a5db8ae679465e946e7fab8275378a36c1eaf3aba41e0f5a095dddd74) |

### B. Verifiable Mainnet Transactions

| Action | Digest | Explorer |
| :--- | :--- | :--- |
| **Move v3 Upgrade (Permissionless Active LP)** | `DrYj3weEWqLB84buddiPy1gtAmmXuDYtDo6GJo4fjGCg` | [View Tx ↗](https://suivision.xyz/txblock/DrYj3weEWqLB84buddiPy1gtAmmXuDYtDo6GJo4fjGCg) |
| **Move v4 Security Hardening Upgrade** | `AfPXqgLXUL7wZm6MWnX23iDk3YhzkMNjvgZjjzd8bLVM` | [View Tx ↗](https://suivision.xyz/txblock/AfPXqgLXUL7wZm6MWnX23iDk3YhzkMNjvgZjjzd8bLVM) |
| **Mainnet `migrate_version` (`cetus005` + `turbos005` -> v4)** | `C4mmjKo3KFzoyc7PbmxVWu73v6hyVPeq9CJLNtYEstCF` | [View Tx ↗](https://suivision.xyz/txblock/C4mmjKo3KFzoyc7PbmxVWu73v6hyVPeq9CJLNtYEstCF) |

### C. Earlier Sui Testnet Lifecycle Proofs

| Protocol Action | Transaction Digest | Verification |
| :--- | :--- | :--- |
| **1. Initial Testnet Publish (`0x9012c6...`)** | `6jkfDxKuKK9KYToXbpMTDmW2eFagj3Ssj7JAVfDKhSvX` | [SuiVision Testnet ↗](https://testnet.suivision.xyz/txblock/6jkfDxKuKK9KYToXbpMTDmW2eFagj3Ssj7JAVfDKhSvX) |
| **2. Testnet Vault Instantiation (`0x630639...`)** | `CPD872yWoxBDPg9xSxfkiPwt74kdBJcuDqPLHwWiyoQK` | [SuiVision Testnet ↗](https://testnet.suivision.xyz/txblock/CPD872yWoxBDPg9xSxfkiPwt74kdBJcuDqPLHwWiyoQK) |
| **3. Deposit & `VaultShare` Split** | `HW3Jn5RJbsXLnwXaYSqyDJq3mUZhHPUKPTcm9eqh8RvD` | [SuiVision Testnet ↗](https://testnet.suivision.xyz/txblock/HW3Jn5RJbsXLnwXaYSqyDJq3mUZhHPUKPTcm9eqh8RvD) |
| **4. Fee Harvest & 10% Treasury Split** | `AXB5PTTWfs3hQ4ANgUk5vw1Eq9X6Bo2gLHnWEYJoYq31` | [SuiVision Testnet ↗](https://testnet.suivision.xyz/txblock/AXB5PTTWfs3hQ4ANgUk5vw1Eq9X6Bo2gLHnWEYJoYq31) |
| **5. Partial Redemption & Burn** | `EmSjHzrkVRRcwbcrAYEHeEqH8VG2hPpaJiatnx5nGM2S` | [SuiVision Testnet ↗](https://testnet.suivision.xyz/txblock/EmSjHzrkVRRcwbcrAYEHeEqH8VG2hPpaJiatnx5nGM2S) |

---

## 3. Problem Statement & Sui Advantage

1. **CLMM Capital Dormancy:** Tight SUI/USDC concentrated ranges (e.g., `0.05%` fee-tier pools) deliver high APRs only while spot remains in range. When price drifts out of bounds, LP fee yield drops to zero.
2. **Atomic Execution via Sui PTBs:** BluSky-Sui chains fee collection, treasury fee split (`harvest_and_compound`), `remove_liquidity`, position close/burn (reclaiming SUI storage rebates), bounded ratio swap (`flash_swap` / `swap_router` with explicit `sqrtPriceLimit` and `minOut`), new tick-range open/mint, and hot-potato vault re-lock in **one atomic PTB**.
3. **Permissionless User Flows:** Independently signed user transactions (`deposit_cetus_active`, `withdraw_cetus_active`, `deposit_turbos_active`, `withdraw_turbos_active`) mint/burn `VaultShare<CoinA, CoinB>` strictly from on-chain pool liquidity invariants (`delta_liq / liq_before`) without requiring an operator co-signature.

---

## 4. Product Suite (Live on Mainnet Pilot)

### Product 1: Automated Dual-DEX `0.05%` CLMM Vaults (Cetus + Turbos)
- **Single-Sided USDC Zap-In:** Automatically swaps optimal USDC -> SUI, injects liquidity into the active pool position, and refunds unused dust in one transaction.
- **Flexible Single-Tx Withdrawals:** Users choose **Pro-Rata (`USDC + SUI`)** with 0% swap fee or **1-Click `100% USDC (Auto-Swap)`** Zap-Out.
- **Economic Viability Filter:** Automated rebalances only run when net gas + swap cost satisfies protocol cost-to-fee guardrails.

### Product 2: Bluefin Pro Perps Delta-Neutral Hedging Layer
- **Live `SUI-PERP` 1x Short Synchronization:** Tracks aggregate spot SUI exposure across Cetus + Turbos vaults and maintains a matching short hedge on **Bluefin Pro Mainnet** via slippage-bounded `LIMIT` + `IOC` orders.
- **Instant Post-Tx Sync & Margin Transparency:** Every confirmed Mainnet deposit or withdrawal immediately triggers a hedge delta check; the dashboard displays live free margin capacity (`maxHedgeableNewDepositUsd`) and buffer health.

### Product 3: Security Posture & Pre-Audit Hardening
- Completed an **internal AI-assisted adversarial review** covering `vault.move` and both off-chain PTB builders, remediated all 8 identified issues in **Move v4**, and expanded [vault_tests.move](file:///c:/Projects/BluSky-Sui/move/tests/vault_tests.move) to **36/36 passing tests** (including idle-dilution prevention via `absorb_pro_rata_idle`, active-position guards on legacy entries, `ExpectedPosKey` custody locks, `VersionKey` gating, and tight PTB swap slippage bounds).
- **Important Transparency:** Internal pre-audit hardening is *not* a substitute for an independent Tier-1 Move security audit. Before scaling public external TVL, BluSky-Sui plans an external formal Move audit, `AdminCap`/`UpgradeCap` multisig governance, and deployment of a clean fresh `original-id` package (so historical `v1–v3` bytecode cannot interact with public vaults).

---

## 5. Roadmap & Requested Support

We welcome **either** a milestone-based ecosystem grant (**$75,000 USD**) **or** **Sui Foundation Security Audit Subsidy / Co-Funded Partner Audit Support** with Cetus, Turbos, and Bluefin:

| Milestone | Status | Scope & Deliverables | Target Allocation |
| :--- | :--- | :--- | :--- |
| **M1: Core Engine, Dual-DEX Mainnet Pilot & Move v4** | **Completed ✅** | Atomic Cetus & Turbos PTBs, Bluefin Pro IOC hedging, permissionless USDC Zap-In & 100% USDC Zap-Out, Wallet Standard web dApp (`app.bluskysui.xyz`), 36/36 Move tests. | **$20,000** *(Retroactive / Pilot Verification)* |
| **M2: External Tier-1 Move Audit & Clean Mainnet Launch** | **Next Priority 🎯** | Independent audit by OtterSec / MoveBit / Zellic *(eligible for Sui Foundation audit subsidy / co-funding)*, public report, multisig governance, and clean `original-id` Mainnet vault migration. | **$25,000** *(6 Weeks)* |
| **M3: Open-Source TypeScript SDK & Partner Integrations** | **Planned** | Published `@blusky-sui/sdk` npm package, Cetus/Turbos vault adapter docs, unified perp/LP NAV settlement keeper, and monitoring telemetry. | **$15,000** *(4–6 Weeks)* |
| **M4: Public TVL Scaling & Ecosystem Co-Marketing** | **Planned** | Uncapped public launch across Cetus, Turbos, and Bluefin, DefiLlama adapter listing, and TVL growth incentives. | **$15,000** *(4 Weeks)* |

---

## 6. Protocol Economics & Ecosystem Synergy

- **Fee Model:** `0%` management/deposit/exit fee; **10.0% performance fee** strictly on harvested LP trading yield (`90%` compounded directly back into vault liquidity).
- **Cetus & Turbos:** Keeps concentrated liquidity centered around spot price, reducing slippage and increasing fee velocity on flagship `0.05%` SUI/USDC pools.
- **Bluefin Pro:** Drives sustained `SUI-PERP` delta-neutral hedging volume and balanced open interest.
- **Composability:** Transferable `VaultShare<CoinA, CoinB>` objects enable downstream collateral integrations across Sui money markets.
