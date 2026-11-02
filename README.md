# BluSky-Sui: Next-Gen Automated DeFi & CLMM Liquidity Vaults

BluSky-Sui is an autonomous, high-frequency liquidity management and DeFi execution protocol built natively for the Sui Network. Leveraging Sui's **Programmable Transaction Blocks (PTBs)**, **object-centric state model**, and **Mysticeti sub-400ms finality**, BluSky-Sui solves the single biggest problem in concentrated liquidity: **maximizing trading fee APR while eliminating out-of-range capital dormancy and reducing impermanent loss**.

---

## 🎯 Flagship Product: Automated CLMM Liquidity Vaults ("Arrakis / Gamma for Sui")

### The Problem in Current Sui LPs (Turbos & Bluefin)
Concentrated liquidity market makers (CLMMs) deliver massive APYs (~80%–120%+ on SUI/USDC) by concentrating liquidity into narrow price bands. However:
1. **Out-of-Range Freeze:** When SUI breaks out of the band, the position stops earning 100% of trading fees and shifts entirely into the underperforming asset (100% SUI if dumping, 100% USDC if pumping).
2. **High Manual Overhead:** LPs must manually monitor prices 24/7, claim fees, re-swap balances to 50:50, and mint new NFT positions.
3. **Severe Impermanent Loss:** Sharp directional moves leave static LPs underwater relative to simple buy & hold.

### The BluSky-Sui Solution
An autonomous execution engine that:
* **Dynamically Re-centers Ranges:** Uses volatility indicators (ATR / Bollinger Bands) to adjust tick ranges before positions go dormant.
* **Atomic PTB Execution:** Gathers fees, swaps asset ratios, burns the old position, and mints the new concentrated position in a **single atomic Programmable Transaction Block**.
* **Continuous Auto-Compounding:** Re-invests fee yields continuously to maximize compounded APY.
* **Economic Viability Safeguard:** Rebalances only when estimated gas + swap costs are strictly `< 20%` of accrued fees.
* **Optional Delta-Neutral Hedging:** Connects to Bluefin Perps to short 1x SUI, converting volatile ~100% APR into stable, market-neutral 30%–50% USD cash flow.

---

## 📁 Repository Structure

* [CLMM_AUTOMATION_PLAN.md](CLMM_AUTOMATION_PLAN.md): Complete architectural blueprint, math specification, PTB workflows, and phased development roadmap.
* `src/`:
  * `src/config.mjs`: Central configuration, RPC endpoints, pool IDs, and strategy parameters.
  * `src/services/wallet.mjs`: Multi-format Sui keypair loader (`suiprivkey...`, hex, base64) with read-only fallback.
  * `src/strategy/rebalanceMath.mjs`: Pure CLMM math (sqrtPrice <-> price, tick spacing alignment, drift percentage, optimal swap ratio calculation, economic viability validation).
  * `src/services/turbos.mjs`: Turbos Finance CLMM adapter, pool & position state reader, accrued fee extractor.
  * `src/ptb/rebalanceBuilder.mjs`: 6-step atomic Programmable Transaction Block builder and simulation engine.
  * `src/services/monitor.mjs`: Autonomous position monitoring daemon and evaluation loop.
  * `src/index.mjs`: Interactive CLI dashboard and daemon entrypoint.
  * `src/test_connection.mjs`: RPC and Turbos SDK health verification.

---

## 🚀 Phased Roadmap

| Phase | Milestone | Status | Objective |
| :--- | :--- | :--- | :--- |
| **Phase 1** | **Off-Chain Personal Bot** | ✅ **Active** | TypeScript bot automating LP on Turbos & Bluefin via PTBs. Real-time drift detection and atomic rebalancing. |
| **Phase 2** | **Delta-Neutral Hedging** | ⏳ Planned | Automated short hedging via Bluefin Perps SDK to eliminate SUI price drop risk. |
| **Phase 3** | **Non-Custodial Move Contracts** | ⏳ Planned | Move Package minting LP share objects (`VaultLP<SUI_USDC>`), protocol fee hooks (10%–15% performance fee), and public web dashboard. |
| **Phase 4** | **Sui Foundation Grant & Scale** | ⏳ Planned | Apply for Sui Foundation DeFi grant and co-market with Turbos, Cetus, and Bluefin. |

---

## 🛠️ Quickstart

### 1. Install dependencies
```bash
npm install
```

### 2. Configure credentials in `.env`
```bash
cp .env.example .env
```

### 3. Test Sui RPC connection
```bash
npm run test:sui
```

### 4. Run Position Monitor
```bash
# Run a single inspection cycle
npm run monitor:once

# Run continuous background monitoring daemon
npm run monitor

# Test automated atomic rebalancing with simulated market drift
npm run simulate:drift
```
