# Sui Foundation Developer Grant Application

**Project Name:** BluSky-Sui  
**Category:** DeFi Infrastructure / Concentrated Liquidity & Yield Optimization  
**Requested Grant Amount:** $75,000 USD (Non-dilutive, milestone-based)  
**Project Status:** Functional Alpha (Off-Chain Execution Engine & Move 2024 Package Implemented)  
**Target Networks:** Sui Mainnet & Testnet  
**Primary Ecosystem Partners:** Turbos Finance, Bluefin, Cetus Protocol  

---

## 1. Executive Summary

Concentrated Liquidity Market Makers (CLMMs) on Sui are currently delivering the highest trading fee yields in all of Web3, with annual percentage rates ranging from **80% to 120%+ on the SUI/USDC pair**. However, these yields are accompanied by severe operational friction: **price drift causes static positions to fall out of range within days**, freezing fee accrual to 0% and causing severe impermanent loss.

**BluSky-Sui** is an autonomous, non-custodial liquidity management protocol natively architected for Sui. It automates CLMM range re-centering, continuous fee compounding, and optional **Delta-Neutral Hedging via Bluefin Perps**.

By leveraging Sui’s native superpowers—specifically **Programmable Transaction Blocks (PTB)**, **Mysticeti sub-400ms finality**, and the **Move 2024 object model**—BluSky-Sui accomplishes atomic multi-step rebalancing directly on-chain with zero intermediary custody risk, sub-cent gas fees (<$0.01), and zero MEV front-running vulnerability.

---

## 2. The Problem Statement & Market Opportunity

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

## 3. Why Sui? (Technical Differentiators)

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

## 4. Product Suite

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

---

## 5. Ecosystem Impact & Synergies

| Protocol | Synergy & Value Added |
| :--- | :--- |
| **Turbos Finance & Cetus** | Concentrates liquidity permanently at the spot price, substantially deepening orderbooks, lowering trading slippage, and driving fee volume. |
| **Bluefin Exchange** | Channels continuous hedging volume, increases sustained open interest (OI), and stabilizes perpetual funding rates. |
| **Scallop & Navi Protocol** | Transferable `VaultShare<SUI_USDC>` tokens create high-yielding collateral assets for lending markets. |
| **Sui Network Overall** | Establishes a premier native liquidity layer, attracting institutional capital and TVL seeking automated, non-custodial yield. |

---

## 6. Project Roadmap & Milestone Deliverables

We are requesting a milestone-based grant of **$75,000 USD** distributed across four transparent deliverables:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Milestone Roadmap                                 │
│                                                                             │
│  [M1: Prototype & PTBs] ──> [M2: Smart Contract Audit]                      │
│     ($20,000 - COMPLETED)         ($25,000 - 6 Weeks)                       │
│                                           │                                 │
│                                           ▼                                 │
│  [M4: Mainnet & Partnerships] <─── [M3: Testnet & Web App]                  │
│     ($15,000 - 4 Weeks)                   ($15,000 - 6 Weeks)               │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Milestone 1: Core Execution Engine & PTB Builder (COMPLETED)
* **Grant Amount:** $20,000 (Retroactive / Foundation Verification)
* **Deliverables:**
  * Complete off-chain TypeScript daemon and monitoring infrastructure.
  * Turbos CLMM SDK & `@mysten/sui` v2 integration.
  * 6-step atomic PTB rebalance builder with simulation and dry-run modes.
  * Delta-neutral hedging engine and Bluefin Perps dynamic re-centering math.
  * Move 2024 non-custodial vault contract prototype (`blusky_vault`).
* **Verification:** Open-source repository with runnable test suite and CLI dashboard.

### Milestone 2: Move Contract Security Audit & Hardening (Month 2)
* **Grant Amount:** $25,000
* **Deliverables:**
  * Engage a leading Sui security auditor (e.g., OtterSec, MoveBit, or Zellic) to conduct a full formal audit of `blusky_vault::vault` and `blusky_vault::events`.
  * Implement formal verification proofs for invariant safety (e.g., share dilution protection, non-extractable principal).
  * Publish the full audit report publicly.
* **Verification:** Published audit report and clean remediation commit on GitHub.

### Milestone 3: Testnet Deployment, SDK, & Web Application (Month 3–4)
* **Grant Amount:** $15,000
* **Deliverables:**
  * Deploy `blusky_vault` to Sui Testnet.
  * Launch responsive public web interface (Next.js/React + `@mysten/dapp-kit`) for single-click deposits, share redemptions, and real-time yield analytics.
  * Open-source TypeScript SDK (`@blusky-sui/sdk`) for third-party protocol integrations.
* **Verification:** Publicly accessible Testnet dApp connected to Sui testnet wallets.

### Milestone 4: Mainnet Launch, Pilot Scaling, & DEX Integration (Month 4–5)
* **Grant Amount:** $15,000
* **Deliverables:**
  * Mainnet deployment of verified Move packages.
  * Seed the flagship SUI/USDC vault with initial pilot capital ($20,000–$50,000).
  * Formalize integrations and co-marketing campaigns with Turbos Finance and Bluefin.
  * Achieve **$1,000,000+ TVL** within 60 days of public launch.
* **Verification:** Mainnet package verified on SuiScan/Suivision; TVL verifiable on DefiLlama.

---

## 7. Budget & Fund Allocation

| Category | Allocation | Description |
| :--- | :--- | :--- |
| **Security Audits** | **$30,000 (40%)** | Tier-1 Move security audit and formal verification. |
| **Frontend & UI Engineering** | **$18,750 (25%)** | Production dApp with `@mysten/dapp-kit` integration and analytics. |
| **Infrastructure & Relayers** | **$15,000 (20%)** | Redundant RPC nodes, dedicated rebalancer servers, and indexing services. |
| **Documentation & Developer Tooling**| **$11,250 (15%)** | Comprehensive developer docs, SDK examples, and ecosystem education. |
| **Total** | **$75,000** | Non-dilutive grant funding. |

---

## 8. Protocol Business Model & Self-Sustainability

BluSky-Sui is designed for indefinite self-sustainability from Day 1:
* **Zero Management Fee:** 0% deposit or asset-management fees to encourage maximum TVL inflow.
* **Performance Fee on Pure Yield:** The on-chain vault contract deducts a **10.0% performance fee** strictly from harvested trading fees and funding payments.
* **Revenue Projections:**
  * At **$1,000,000 TVL** @ 100% APR = **$100,000 / year** protocol revenue.
  * At **$10,000,000 TVL** @ 100% APR = **$1,000,000 / year** protocol revenue.
* Protocol fees are directed to the DAO treasury to continuously fund operations, security audits, and developer incentives without needing recurring external capital.

---

## 9. Competitive Landscape Comparison

| Feature | Legacy EVM (Gamma / Arrakis) | Solana (Kamino) | **BluSky-Sui (Native Sui)** |
| :--- | :--- | :--- | :--- |
| **Execution Architecture** | Multiple transactions or proxy contracts | Rust anchor programs | **Atomic 6-Step Programmable Transaction Block (PTB)** |
| **Execution Cost** | $15.00 – $60.00 / rebalance | $0.05 – $0.15 / rebalance | **< $0.01 / rebalance (subsidized by storage rebates)** |
| **Rebalance Finality** | 12 – 15 seconds (MEV sandwich risk) | 400 – 800 ms | **< 390 ms (Mysticeti consensus, zero front-running)** |
| **Delta-Neutral Hedging** | Complex off-chain routing | Limited cross-margin | **Synchronized Turbos CLMM + Bluefin Perps 1x Short** |
| **Share Token Standard** | ERC-20 token | SPL token | **First-class Move 2024 Object (`VaultShare<T, B>`)** |
| **Operator Security** | Custom allowances / multisigs | Program authority | **Cryptographic `OperatorCap` (Zero custody over principal)** |

---

## 10. Conclusion & Request for Support

BluSky-Sui provides the missing infrastructural link required to transition Sui's concentrated liquidity from speculative, high-maintenance farming into institutional, passive capital allocation.

With the core off-chain execution daemon, atomic PTB builder, and Move 2024 contract architecture already implemented and validated, grant support from the Sui Foundation will accelerate smart contract auditing, dApp deployment, and ecosystem liquidity scaling.

We look forward to collaborating with the Sui Foundation to solidify Sui as the premier DeFi execution layer in Web3.

