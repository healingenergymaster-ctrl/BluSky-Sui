# Sui Foundation Developer Grant Application

**Project Name:** BluSky-Sui  
**Category:** DeFi Infrastructure / Concentrated Liquidity & Yield Optimization  
**Requested Grant Amount:** $75,000 USD (Non-dilutive, milestone-based)  
**Project Status:** Functional Alpha & Live Testnet Verified (Move 2024 Package & Shared Vault Deployed on Sui Testnet)  
**Target Networks:** Sui Mainnet & Testnet  
**Primary Ecosystem Partners:** Cetus Protocol (#1 Sui DEX), Turbos Finance, Bluefin Exchange  

---

## 1. Executive Summary

Concentrated Liquidity Market Makers (CLMMs) on Sui are currently delivering the highest trading fee yields in all of Web3, with annual percentage rates ranging from **80% to 120%+ on the SUI/USDC pair**. However, these yields are accompanied by severe operational friction: **price drift causes static positions to fall out of range within days**, freezing fee accrual to 0% and causing severe impermanent loss.

**BluSky-Sui** is an autonomous, non-custodial liquidity management protocol natively architected for Sui. It automates CLMM range re-centering, continuous fee compounding, and optional **Delta-Neutral Hedging via Bluefin Perps** across Sui's dominant decentralized exchanges—anchored primarily by **Cetus Protocol** (70%+ market share) alongside **Turbos Finance**.

By leveraging Sui’s native superpowers—specifically **Programmable Transaction Blocks (PTB)**, **Mysticeti sub-400ms finality**, and the **Move 2024 object model**—BluSky-Sui accomplishes atomic multi-step rebalancing directly on-chain with zero intermediary custody risk, sub-cent gas fees (<$0.01), and zero MEV front-running vulnerability.

---

## 2. Live Testnet Deployment & Verifiable On-Chain Proofs

Unlike purely conceptual proposals, BluSky-Sui has already compiled, published, and validated its Move 2024 smart contract package and shared vault object on **Sui Testnet**. 

Every core capability of the protocol—from initial asset deposit and fractional share splitting to yield compounding and protocol treasury fee routing—has been executed on-chain by Sui validators:

### A. Published On-Chain Objects (Sui Testnet)

| Object Role | Object ID / Address | Explorer Link |
| :--- | :--- | :--- |
| **Move 2024 Package** | `0x9012c6d5deddf25d936ffe5aeadc6849c9488223e7f81cb54f8faced78d23844` | [SuiVision Package View](https://testnet.suivision.xyz/package/0x9012c6d5deddf25d936ffe5aeadc6849c9488223e7f81cb54f8faced78d23844) |
| **Shared Vault Object** | `0x630639ff9b39e8515ce648202a3d919d95ab421aa1f2f6903875964fed0708dc` | [SuiVision Vault View](https://testnet.suivision.xyz/object/0x630639ff9b39e8515ce648202a3d919d95ab421aa1f2f6903875964fed0708dc) |
| **Package UpgradeCap** | `0x37fa2800fc91802c59e2ed4877497211e78cbe68e1644dbd5bca36eb425cd9d8` | [SuiVision UpgradeCap View](https://testnet.suivision.xyz/object/0x37fa2800fc91802c59e2ed4877497211e78cbe68e1644dbd5bca36eb425cd9d8) |
| **Protocol AdminCap** | `0x137b746c5a05111463c49a6cd0ee8d641679a207c1cfef5d0700cb3f66b5e976` | [SuiVision AdminCap View](https://testnet.suivision.xyz/object/0x137b746c5a05111463c49a6cd0ee8d641679a207c1cfef5d0700cb3f66b5e976) |
| **Autonomous OperatorCap** | `0x2ba5abe25e4373e72b17c503c3033b83116735714ae4ab179ebd62b5fc64c6c6` | [SuiVision OperatorCap View](https://testnet.suivision.xyz/object/0x2ba5abe25e4373e72b17c503c3033b83116735714ae4ab179ebd62b5fc64c6c6) |
| **Protocol Fee Treasury** | `0xa81ad397c3aadae2ddcfde5cef96aa21d4f445c918f8d819c5ea757aafa8f6db` | [SuiVision Treasury Account](https://testnet.suivision.xyz/account/0xa81ad397c3aadae2ddcfde5cef96aa21d4f445c918f8d819c5ea757aafa8f6db) |

---

### B. 100% Verifiable On-Chain Transaction Lifecycle

The complete architectural lifecycle has been tested and recorded on Sui Testnet blocks:

| Protocol Action | Transaction Digest | On-Chain Verification | Latency & Gas |
| :--- | :--- | :--- | :--- |
| **1. Package Publication** | `6jkfDxKuKK9KYToXbpMTDmW2eFagj3Ssj7JAVfDKhSvX` | [View on SuiVision ↗](https://testnet.suivision.xyz/txblock/6jkfDxKuKK9KYToXbpMTDmW2eFagj3Ssj7JAVfDKhSvX) | Verified bytecode publish; created UpgradeCap |
| **2. Vault Instantiation** | `CPD872yWoxBDPg9xSxfkiPwt74kdBJcuDqPLHwWiyoQK` | [View on SuiVision ↗](https://testnet.suivision.xyz/txblock/CPD872yWoxBDPg9xSxfkiPwt74kdBJcuDqPLHwWiyoQK) | Created shared Vault, AdminCap, and OperatorCap |
| **3. Atomic Deposit & Share Split** | `HW3Jn5RJbsXLnwXaYSqyDJq3mUZhHPUKPTcm9eqh8RvD` | [View on SuiVision ↗](https://testnet.suivision.xyz/txblock/HW3Jn5RJbsXLnwXaYSqyDJq3mUZhHPUKPTcm9eqh8RvD) | 2,448ms · Minted 100M shares & split 25% child share |
| **4. Fee Harvest & Treasury Routing** | `AXB5PTTWfs3hQ4ANgUk5vw1Eq9X6Bo2gLHnWEYJoYq31` | [View on SuiVision ↗](https://testnet.suivision.xyz/txblock/AXB5PTTWfs3hQ4ANgUk5vw1Eq9X6Bo2gLHnWEYJoYq31) | 3,094ms · 10% fee routed to treasury; 90% auto-compounded |
| **5. Partial Share Redemption & Burn** | `EmSjHzrkVRRcwbcrAYEHeEqH8VG2hPpaJiatnx5nGM2S` | [View on SuiVision ↗](https://testnet.suivision.xyz/txblock/EmSjHzrkVRRcwbcrAYEHeEqH8VG2hPpaJiatnx5nGM2S) | 1,903ms · Burned 25M shares; returned pro-rata assets |

---

## 3. The Problem Statement & Market Opportunity

### A. The Inherent Dilemma of Concentrated Liquidity
In CLMMs (Turbos, Cetus), liquidity providers must concentrate capital into narrow price bands (e.g., ±7% around spot) to achieve 15x–20x capital efficiency. However:
1. **Out-of-Range Freeze:** When SUI breaks through the band boundaries, 100% of trading fees halt immediately, leaving the LP holding entirely the depreciating asset (100% SUI in a dump) or missing the upside (100% USDC in a pump).
2. **Operational Overhead:** Active LPs must manually monitor markets 24/7, harvest fees across multiple transactions, swap tokens back to optimal ratios, burn old NFTs, and mint new ones.
3. **Execution Churn on Legacy Chains:** On EVM (Uniswap V3), rebalancing requires either deploying rigid contract intermediaries or executing 4+ separate transactions, exposing the user to severe slippage and sandwich attacks.

### B. The Market Size on Sui
* Sui DeFi TVL has surged past **$1B+**, with daily DEX volume regularly exceeding **$100M–$250M**.
* Yet, over **65% of CLMM positions on Sui are currently out-of-range**, representing millions of dollars in dormant, non-productive liquidity.
* BluSky-Sui acts as the **"Gamma / Arrakis / Yearn" for the Sui ecosystem**, converting volatile, high-maintenance LPing into passive, institutional-grade automated vaults.

---

## 4. Why Sui? (Technical Differentiators)

BluSky-Sui is fundamentally unbuildable with comparable efficiency on EVM or Solana. It directly utilizes three architectural pillars unique to Sui:

### 1. Atomic Programmable Transaction Blocks (PTB)
On Sui, a client transaction can chain up to 1,024 commands atomically. BluSky-Sui executes an entire rebalance cycle in a **single PTB**:

```
┌────────────────────────────────────────────────────────────────────────────┐
│                    Sui Programmable Transaction Block                      │
│                                                                            │
│  1. turbos::collect_fee(PositionNFT) ──────────────> Harvest Accrued Fees  │
│  2. turbos::decrease_liquidity(PositionNFT, 100%) ─> Withdraw Principal    │
│  3. turbos::burn(PositionNFT) ─────────────────────> Storage Rebate Credit │
│  4. dex_router::swap_optimal_ratio(...) ───────────> Perfect Ratio Entry   │
│  5. turbos::mint(new_lower_tick, new_upper_tick) ──> Mint Concentrated NFT │
│  6. transfer::public_transfer(NewNFT, Vault/User) ─> Custody Preserved     │
└────────────────────────────────────────────────────────────────────────────┘
```
* **Zero Intermediary Risk:** If any step (such as slippage check or mint) fails, the entire transaction reverts atomically. Funds never leave the owner/vault.
* **Storage Rebates:** Burning exhausted Position NFTs returns SUI storage rebates, partially subsidizing execution gas.

### 2. Mysticeti Consensus Engine
With Sui’s Mysticeti consensus delivering sub-400ms finality, atomic rebalances settle before cross-DEX arbitrageurs can front-run or sandwich the rebalance swap.

### 3. Move 2024 Object Model & `OperatorCap`
* **Transferable `VaultShare<CoinA, CoinB>` Objects:** Depositors receive first-class on-chain objects representing vault shares that can be transferred, held, or integrated as collateral in money markets (Scallop, Navi).
* **Non-Custodial Privilege Separation:** The automated rebalance daemon holds only an `OperatorCap`. It is cryptographically prohibited from withdrawing investor principal—it can only adjust tick bounds and harvest/compound yields.

---

## 5. Product Suite

### Product 1: Dynamic Volatility-Adaptive CLMM Vaults
* **Dynamic Range Sizing:** Adjusts band widths dynamically (±6% during low-volatility accumulation; ±15% during momentum expansions) using ATR (Average True Range).
* **Economic Viability Safeguard:** A rebalance is only executed if:
  $$\text{Rebalance Cost (Slippage + Gas)} < 0.20 \times \text{Unclaimed Accrued Fees}$$
  This mathematical invariant guarantees that automation never erodes investor returns.
* **Continuous Auto-Compounding:** Reinvests fee yields continuously to maximize compounded APY.

### Product 2: Delta-Neutral Hedging Layer (Bluefin Perps Integration)
For liquidity providers who want high yields without exposure to SUI price volatility:
* Calculates instantaneous CLMM spot delta: $\Delta_{\text{spot}} = \frac{dV}{dP} = x \text{ (SUI quantity held in pool)}$.
* Automatically maintains an equal 1x Short on Bluefin Perps (`SUI-PERP`).
* **Dynamic Delta Re-Centering:** When market price moves and the CLMM pool trades between SUI and USDC, the hedging engine automatically resizes the short position to preserve $\Delta_{\text{net}} \approx 0$.
* **Yield Stacking:** Captures ~100% CLMM fee APR plus positive perpetual funding yield (~16% APR paid by longs to shorts) = **~110%–125% Net Annualized USD Return with Zero Market Beta**.

### Product 3: Dual-DEX Architecture & Smart Yield Routing (Cetus + Turbos)
Rather than locking liquidity into a single exchange, BluSky-Sui implements a modular adapter architecture:
* **Dedicated Flagship Vaults:**
  * **BluSky Cetus SUI/USDC Vault:** Leverages Cetus Protocol’s deep institutional orderbooks ($25M–$60M+ 24h volume) for steady, non-dilutive fee capture.
  * **BluSky Turbos SUI/USDC Vault:** Targets aggressive yield-farming opportunities and incentive-boosted rewards.
* **Cross-DEX Yield Routing Engine:** Evaluates live APR spreads between Cetus and Turbos. Incorporates a **15% sustained APR spread threshold over 24 hours** before triggering pool rotations, ensuring cross-DEX rebalancing slippage never outpaces fee yield advantages.

---

## 6. Ecosystem Impact & Synergies

| Protocol | Synergy & Value Added |
| :--- | :--- |
| **Cetus Protocol (#1 Sui DEX)** | Captures 70%+ of Sui DEX volume; BluSky solves the dormant capital problem by keeping liquidity permanently centered at spot, drastically reducing user slippage. |
| **Turbos Finance** | Channels targeted automated LP capital to Turbos CLMM pools, driving trading fee velocity and deepening liquidity depth. |
| **Bluefin Exchange** | Channels continuous hedging volume, increases sustained open interest (OI), and stabilizes perpetual funding rates. |
| **Scallop & Navi Protocol** | Transferable `VaultShare<SUI_USDC>` tokens create high-yielding collateral assets for lending markets. |
| **Sui Network Overall** | Establishes a premier native liquidity layer, attracting institutional capital and TVL seeking automated, non-custodial yield. |

---

## 7. Project Roadmap & Milestone Deliverables

We are requesting a milestone-based grant of **$75,000 USD** distributed across four transparent deliverables:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Milestone Roadmap                                 │
│                                                                             │
│  [M1: Prototype, PTBs & Testnet] ──> [M2: Smart Contract Audit]             │
│     ($20,000 - COMPLETED ✅)               ($25,000 - 6 Weeks)               │
│                                                   │                         │
│                                                   ▼                         │
│  [M4: Mainnet & Dual-DEX Scaling] <──── [M3: Cetus/Turbos Web App & SDK]    │
│     ($15,000 - 4 Weeks)                           ($15,000 - 6 Weeks)       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Milestone 1: Core Execution Engine, PTB Builder & Testnet Validation (COMPLETED ✅)
* **Grant Amount:** $20,000 (Retroactive / Foundation Verification)
* **Deliverables Completed:**
  * Off-chain TypeScript daemon and continuous position monitoring infrastructure.
  * Turbos CLMM SDK & Cetus SDK (`@cetusprotocol/cetus-sui-clmm-sdk`) modular integration.
  * 6-step atomic PTB rebalance builder with simulation and live execution modes.
  * Delta-neutral hedging engine and Bluefin Perps dynamic re-centering math.
  * Move 2024 non-custodial vault contract (`blusky_vault::vault`) compiled, published, and verified on **Sui Testnet** (`0x9012c6d5deddf25d936ffe5aeadc6849c9488223e7f81cb54f8faced78d23844`).
  * On-chain lifecycle verified: atomic deposit, fractional share splitting, 10% fee routing to DAO treasury, and partial share redemption.
* **Verification:** Open-source repository with runnable test suite, interactive web dashboard, and verified SuiVision transaction blocks.

### Milestone 2: Move Contract Security Audit & Hardening (Month 2)
* **Grant Amount:** $25,000
* **Deliverables:**
  * Engage a leading Sui security auditor (e.g., OtterSec, MoveBit, or Zellic) to conduct a full formal audit of `blusky_vault::vault`.
  * Implement formal verification proofs for invariant safety (e.g., share dilution protection, non-extractable principal).
  * Publish the full audit report publicly.
* **Verification:** Published audit report and clean remediation commit on GitHub.

### Milestone 3: Production Web Application, SDK Packaging & Cetus/Turbos Integration (Month 3–4)
* **Grant Amount:** $15,000
* **Deliverables:**
  * Production web interface upgrade using `@mysten/dapp-kit` with multi-wallet standard support (Sui Wallet, Suiet, Nightly, Martian).
  * Direct PTB adapter wiring linking `blusky_vault::deposit` directly with live Cetus and Turbos CLMM pool positions.
  * Open-source TypeScript SDK (`@blusky-sui/sdk`) published to npm for third-party protocol and institutional integrations.
* **Verification:** Production-ready web dApp and publicly accessible npm package.

### Milestone 4: Mainnet Launch, Dual-DEX Pilot Scaling, & Ecosystem Growth (Month 4–5)
* **Grant Amount:** $15,000
* **Deliverables:**
  * Mainnet deployment of audited Move packages.
  * Seed the flagship Cetus & Turbos SUI/USDC vaults with initial pilot capital ($20,000–$50,000).
  * Formalize integrations and co-marketing campaigns with Cetus Protocol, Turbos Finance, and Bluefin.
  * Achieve **$1,000,000+ TVL** within 60 days of public launch.
* **Verification:** Mainnet package verified on SuiScan/Suivision; TVL verifiable on DefiLlama.

---

## 8. Budget & Fund Allocation

| Category | Allocation | Description |
| :--- | :--- | :--- |
| **Security Audits** | **$30,000 (40%)** | Tier-1 Move security audit and formal verification. |
| **Frontend & UI Engineering** | **$18,750 (25%)** | Production dApp with `@mysten/dapp-kit` integration and analytics. |
| **Infrastructure & Relayers** | **$15,000 (20%)** | Redundant RPC nodes, dedicated rebalancer servers, and indexing services. |
| **Documentation & Developer Tooling**| **$11,250 (15%)** | Comprehensive developer docs, SDK examples, and ecosystem education. |
| **Total** | **$75,000** | Non-dilutive grant funding. |

---

## 9. Protocol Business Model & Self-Sustainability

BluSky-Sui is designed for indefinite self-sustainability from Day 1:
* **Zero Management Fee:** 0% deposit or asset-management fees to encourage maximum TVL inflow.
* **Performance Fee on Pure Yield:** The on-chain vault contract deducts a **10.0% performance fee** strictly from harvested trading fees and funding payments.
* **Revenue Projections:**
  * At **$1,000,000 TVL** @ 100% APR = **$100,000 / year** protocol revenue.
  * At **$10,000,000 TVL** @ 100% APR = **$1,000,000 / year** protocol revenue.
* Protocol fees are directed to the DAO treasury to continuously fund operations, security audits, and developer incentives without needing recurring external capital.

---

## 10. Competitive Landscape Comparison

BluSky-Sui combines the automated liquidity vault model (Gamma / Kamino) with Sui's unique native primitives:

| Feature | Legacy EVM *(Gamma / Arrakis)* | Solana *(Kamino)* | **BluSky-Sui *(Native Sui)*** |
| :--- | :--- | :--- | :--- |
| **Execution** | Multi-tx or custom proxy | Rust anchor program | **1 Atomic PTB** *(all-or-nothing execution)* |
| **Cost / Rebalance** | $15.00 – $60.00 | $0.05 – $0.15 | **< $0.01** *(subsidized by storage rebates)* |
| **Finality** | 12 – 15s *(MEV sandwich risk)* | 400 – 800ms | **< 390ms** *(Mysticeti sub-second finality)* |
| **Delta Hedging** | ❌ None / Manual | ⚠️ Limited | **✅ Automated 1x Short** *(Bluefin Perps)* |
| **Share Standard** | ERC-20 token | SPL token | **✅ Move 2024 Object** *(`VaultShare`)* |
| **Operator Safety** | Multisig / Approvals | Authority key | **✅ `OperatorCap`** *(zero access to principal)* |

### Core Differentiators at a Glance:
* ⚡ **100% Atomic Execution:** PTBs chain fee collection, liquidity exits, ratio swaps, and re-mints into a single transaction block—if slippage limits fail, the entire block reverts with zero loss.
* 🛡️ **Cryptographic Safety:** The automated keeper bot holds only an `OperatorCap`. It is mathematically impossible for the bot to withdraw or steal user principal.
* 💰 **Cost Advantage:** Burning exhausted position NFTs recovers Sui storage rebates, keeping net rebalance costs under $0.01.

---

## 11. Conclusion & Request for Support

BluSky-Sui provides the missing infrastructural link required to transition Sui's concentrated liquidity from speculative, high-maintenance farming into institutional, passive capital allocation.

With the core off-chain execution daemon, atomic PTB builder, and Move 2024 contract architecture already implemented and validated on Sui Testnet, grant support from the Sui Foundation will accelerate smart contract auditing, dApp deployment, and ecosystem liquidity scaling.

We look forward to collaborating with the Sui Foundation to solidify Sui as the premier DeFi execution layer in Web3.

