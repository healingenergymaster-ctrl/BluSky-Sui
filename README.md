# BluSky-Sui: Next-Gen Automated DeFi & CLMM Liquidity Vaults

BluSky-Sui is an autonomous, high-frequency liquidity management and DeFi execution protocol built natively for the Sui Network. Leveraging Sui's **Programmable Transaction Blocks (PTBs)**, **object-centric state model**, and **Mysticeti sub-400ms finality**, BluSky-Sui solves the single biggest problem in concentrated liquidity: **maximizing trading fee APR while eliminating out-of-range capital dormancy and neutralizing impermanent loss**.

---

## 🎯 Flagship Products

### 1. Automated CLMM Liquidity Vaults ("Arrakis / Gamma for Sui")
Concentrated liquidity market makers (CLMMs like Turbos & Bluefin) deliver massive APYs (~80%–120%+ on SUI/USDC). BluSky-Sui continuously keeps capital inside the optimal fee-earning zone using atomic PTB rebalancing.

### 2. Delta-Neutral Hedging Layer (Bluefin Perps Integration)
For liquidity providers who want high yields without exposure to SUI price drops:
* Automatically computes instantaneous spot SUI delta ($\Delta_{\text{spot}} = \frac{dV}{dP}$).
* Opens an equal 1x Short on Bluefin Perps (`SUI-PERP`).
* **Dynamic Delta Re-centering:** As spot price fluctuates and the CLMM pool trades between SUI and USDC, the engine dynamically adjusts the short position to keep $\Delta_{\text{net}} \approx 0$.
* **Yield Stacking:** Earns high CLMM trading fees (~100% APR) **plus** positive 8h perp funding rate (~16% APR earned by shorts from longs) = **~115%–125% Net Annualized USD Return with Zero Market Beta**.

---

## 📁 Repository Structure

* [CLMM_AUTOMATION_PLAN.md](CLMM_AUTOMATION_PLAN.md): Complete architectural blueprint, math specification, PTB workflows, and phased development roadmap.
* `src/`:
  * `src/config.mjs`: Central configuration, RPC endpoints, pool IDs, strategy & hedging parameters.
  * `src/services/wallet.mjs`: Multi-format Sui keypair loader (`suiprivkey...`, hex, base64) with read-only fallback.
  * `src/strategy/rebalanceMath.mjs`: Pure CLMM math (sqrtPrice <-> price, tick spacing alignment, drift percentage, optimal swap ratio calculation, economic viability validation).
  * `src/services/turbos.mjs`: Turbos Finance CLMM adapter, pool & position state reader, accrued fee extractor.
  * `src/ptb/rebalanceBuilder.mjs`: 6-step atomic Programmable Transaction Block builder and simulation engine.
  * `src/hedging/deltaMath.mjs`: Instantaneous CLMM delta formula, net delta tracking, margin buffer & liquidation math, market-neutral APY breakdown.
  * `src/services/bluefin.mjs`: Bluefin Perps adapter, position tracker, margin accounting, and 8h funding accrual.
  * `src/hedging/hedgingEngine.mjs`: Master hedging coordinator synchronizing CLMM spot liquidity with Bluefin short perps.
  * `src/services/monitor.mjs`: Autonomous position monitoring daemon and evaluation loop.
  * `src/index.mjs`: Interactive CLI dashboard and daemon entrypoint.
  * `src/test_connection.mjs`: RPC and Turbos SDK health verification.

---

## 🚀 Phased Roadmap

| Phase | Milestone | Status | Objective |
| :--- | :--- | :--- | :--- |
| **Phase 1** | **Off-Chain Personal Bot** | ✅ **Complete** | TypeScript bot automating LP on Turbos & Bluefin via PTBs. Real-time drift detection and atomic rebalancing. |
| **Phase 2** | **Delta-Neutral Hedging** | ✅ **Complete** | Dynamic delta re-centering via Bluefin Perps 1x Short, liquidation buffer tracking, and funding yield capture. |
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

### 3. Run Position & Delta-Neutral Monitor
```bash
# Run a single inspection & hedge evaluation cycle
npm run monitor:once

# Run continuous background monitoring daemon (polls every 30s)
npm run monitor

# Test dynamic delta hedge re-centering on Bluefin Perps
npm run simulate:hedge

# Test automated CLMM atomic PTB tick rebalancing
npm run simulate:drift
```
