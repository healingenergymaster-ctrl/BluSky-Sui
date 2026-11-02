# Complete Architectural Blueprint: Automated CLMM Liquidity Vaults on Sui
**Target Ecosystems:** Turbos Finance & Bluefin (Sui Network)  
**Initial Pilot:** $20,000 SUI/USDC Liquidity Portfolio  
**Grant Application:** [SUI_FOUNDATION_GRANT_APPLICATION.md](SUI_FOUNDATION_GRANT_APPLICATION.md)

---

## Executive Summary

Concentrated Liquidity Market Makers (CLMMs) on Sui are currently the highest-yielding opportunities in all of DeFi, delivering **80% to 120%+ APR** on SUI/USDC pairs due to surging on-chain volume and ecosystem incentives. However, maintaining this APR requires continuous monitoring and proactive rebalancing. A static LP position that drifts out of range yields **0% APR** and suffers maximum impermanent loss.

BluSky-Sui is an automated liquidity management system designed to:
1. Keep capital strictly inside the optimal fee-earning zone.
2. Automate fee harvesting and auto-compounding.
3. Leverage Sui's unique **Programmable Transaction Blocks (PTB)** to execute rebalances atomically with sub-second finality.
4. Provide optional **Delta-Neutral Hedging** via Bluefin Perps to secure high yields with zero downside price exposure.
5. Provide public **Move 2024 Non-Custodial Vaults** with transferable `VaultShare` objects and a self-sustaining **10% performance fee**.

---

## 1. The Economics of the $20,000 SUI/USDC Pilot

| Parameter | Value | Notes |
| :--- | :--- | :--- |
| **Total Pilot Capital** | **$20,000 USDC** | Deployed across Turbos and Bluefin |
| **Current Gross APR** | **~100% APR** | ~$54.79 / day in gross trading fees & rewards |
| **Static LP Vulnerability** | **High** | ±12% price move halts 100% of fee generation |
| **Projected Automated APR** | **115% - 130% APY** | Achieved via dynamic range re-centering + continuous auto-compounding |
| **Daily Fee Harvest** | **~$55 - $71 / day** | Automatically reinvested into new liquidity units |
| **Protocol Revenue (10%)**| **~$5.50 - $7.10 / day** | Non-custodial fee routed directly to treasury |

---

## 2. Dynamic Tick Range & Rebalancing Strategy

### A. Dynamic Range Width Sizing (Volatility-Adaptive)
Rather than static manual bands (e.g. ±10%), the rebalancing engine calculates tick ranges dynamically using:
* **Average True Range (ATR)** and **Bollinger Band Width (BBW)** on the 1-hour chart.
* **Low Volatility Regimes:** Tight range (±5% to ±7%). Concentrates capital 15x–20x, boosting fee share.
* **High Volatility / Expansion Regimes:** Wider range (±12% to ±18%). Prevents excessive rebalancing churn during market runs.

### B. Rebalance Trigger Conditions
A rebalance is triggered only when:
1. **Range Drift Threshold:** The current spot price reaches within **15% of the outer band limit**.
2. **Economic Viability Check:**
   $$\text{Estimated Rebalance Cost (Slippage + Gas)} < 0.20 \times \text{Unclaimed Fees Accrued}$$
   This ensures rebalances never erode portfolio yield.
3. **Trend Filter:** If SUI is undergoing an extreme momentum breakout, the bot widens the asymmetric range toward the trend direction.

---

## 3. The Sui Superpower: Programmable Transaction Blocks (PTBs)

On EVM chains (Uniswap V3), a rebalance requires either multiple separate transactions or deploying a complex, immutable contract to hold user funds. On Sui, **Programmable Transaction Blocks (PTB)** allow chaining up to **1,024 commands in a single atomic client transaction**:

```
┌─────────────────────────────────────────────────────────────────┐
│               Sui Programmable Transaction Block                │
│                                                                 │
│  1. turbos::collect_fee(PositionNFT) ──────────> (Fees SUI/USDC) │
│  2. turbos::remove_liquidity(PositionNFT, 100%) ─> (Prin SUI/USDC)│
│  3. turbos::burn_position(PositionNFT)                          │
│  4. dex_router::swap_optimal_ratio(...) ───────> Rebalance 50:50│
│  5. turbos::mint_position(new_lower_tick, new_upper_tick)        │
│  6. turbos::add_liquidity(NewPositionNFT, TotalSui, TotalUsdc)  │
│  7. transfer::transfer(NewPositionNFT, OwnerAddress)            │
└─────────────────────────────────────────────────────────────────┘
```
**Why this changes everything:**
* **Zero Intermediary Risk:** If the swap or re-mint fails at step 5, the entire transaction reverts. Funds never leave the owner's custody.
* **Sub-Second Execution:** Mysticeti consensus finalizes the entire cycle in ~390ms.
* **Negligible Gas:** The complete 7-step atomic block costs under **0.005 SUI (< $0.015 USD)**.

---

## 4. Delta-Neutral Hedging Layer (Phase 2 Extension)

For liquidity providers who want high yields without exposure to SUI price drops:
* When $10,000 worth of SUI is active in the CLMM pool, the hedging engine automatically opens an **equal $10,000 1x Short SUI-PERP** on Bluefin.
* As SUI price fluctuates, the short perp gains what the spot SUI loses, neutralizing price risk.
* **Net Return:** Yield = Pool Fee APR (~100%) + Funding Rate (~16% APR earned by shorts from longs) - Churn (~1.5%) = **~115% net annualized USD return with zero market beta**.

---

## 5. Phased Development Roadmap

### Phase 1: Personal Automated Bot (COMPLETED ✅)
* Off-chain TypeScript daemon monitoring Turbos & Bluefin on-chain position NFTs.
* Integration with `@mysten/sui` and `turbos-clmm-sdk`.
* CLI dashboard comparing automated returns against static holding.
* Atomic 6-step PTB builder.

### Phase 2: Bluefin Perps Delta-Neutral Hedging (COMPLETED ✅)
* Bluefin adapter for perp margin and 1x short management.
* Dynamic delta re-centering (adjusting short position size as spot ratio changes).
* Market-neutral APY calculation and liquidation safety tracking.

### Phase 3: Move On-Chain Vault Protocol (COMPLETED ✅)
* Deployable Move 2024 package (`blusky_vault::vault`).
* Transferable vault share tokens (`VaultShare<CoinA, CoinB>`).
* Separation of privileges via `OperatorCap`.
* Protocol monetization: **10% performance fee** on trading profits (zero management fee).

### Phase 4: Sui Foundation Grant & Scaling (COMPLETED ✅)
* Complete **Sui Foundation Developer Grant Application** ($75,000 milestone-based request).
* Integration blueprint for Turbos, Cetus, and Bluefin.
* Full application documentation available at [SUI_FOUNDATION_GRANT_APPLICATION.md](SUI_FOUNDATION_GRANT_APPLICATION.md).
