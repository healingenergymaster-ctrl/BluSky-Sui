# BluSky-Sui: Automated Dual-DEX CLMM & Delta-Neutral Vaults on Sui

**Live Mainnet Pilot:** [https://app.bluskysui.xyz](https://app.bluskysui.xyz)

BluSky-Sui is an automated concentrated liquidity and delta-neutral hedging protocol built natively for the **Sui Network**. Using **Programmable Transaction Blocks (PTBs)**, **Mysticeti sub-second finality**, and the **Move 2024 object model**, BluSky-Sui manages active `0.05%` SUI/USDC positions across **Cetus Protocol** and **Turbos Finance** while dynamically delta-hedging spot SUI exposure on **Bluefin Pro (`SUI-PERP`)**.

> **Security Status:** Move **v4** contracts (`0x0e6405...0209`) are deployed on Sui Mainnet with **36/36** passing Move unit & adversarial tests (`sui move test --build-env mainnet --path move`). Internal AI-assisted pre-audit hardening has been completed; an **independent Tier-1 Move security audit** and clean fresh-package migration are scheduled prior to scaling public external TVL.

---

## 🎯 Core Architecture

### 1. Automated Dual-DEX CLMM Vaults (Cetus `0.05%` + Turbos `0.05%`)
- **Single-Signer Permissionless Zap-In & Exit:** Any wallet can deposit single-sided USDC (`deposit_cetus_active` / `deposit_turbos_active`) to mint transferable `VaultShare<CoinA, CoinB>` objects priced directly from on-chain CLMM liquidity deltas, and redeem via **Pro-Rata (`USDC + SUI`)** or **1-Click `100% USDC (Auto-Swap)`** Zap-Out.
- **Atomic PTB Rebalancing:** Collects trading fees, routes a **10.0% performance fee** to the treasury (compounding 90%), exits exhausted liquidity, executes slippage-bounded ratio swaps, and opens + locks a new centered CLMM position inside one atomic PTB.

### 2. Bluefin Pro Perps Delta-Neutral Hedging
- Continuously tracks combined spot SUI exposure ($\Delta_{\text{spot}}$) across active Cetus + Turbos vaults.
- Maintains a matching 1x Short on **Bluefin Pro (`SUI-PERP`)** using tick-quantized, slippage-bounded `LIMIT` + `IOC` orders, with instant post-deposit/withdraw re-hedge sync and live margin headroom telemetry (`maxHedgeableNewDepositUsd`).

### 3. Mainnet Deployment (`Move v4`)
- **Original Package (`VAULT_PACKAGE_ID`):** `0x5ec95b86aec0b1b3b3277383713ee1815a49303b16216d90688dbda5c8cb710a`
- **Upgraded Call Package (v4):** `0x0e6405f42a9e91d3af5b3f8ddcb6ee66558afaba471233d3e61662fb17c40209`
- **Cetus `0.05%` Vault (`cetus005`):** `0xa6ef82cd00e4cbea40bcdbbe2d557590d73dc0c332478ac43ba6e13ea80441ae`
- **Turbos `0.05%` Vault (`turbos005`):** `0x08c282087feee1850d6b66c0ceb2e6ad0885a58413d1bd561df19fd851aaac27`
- **Protocol Fee Treasury (`@bluskysui` / `bluskysui.sui`):** `0xa81ad397c3aadae2ddcfde5cef96aa21d4f445c918f8d819c5ea757aafa8f6db`

---

## 📁 Repository Structure

- [SUI_FOUNDATION_GRANT_APPLICATION.md](SUI_FOUNDATION_GRANT_APPLICATION.md): Sui Foundation Grant & Security Audit Support application with Mainnet + Testnet proofs.
- [CLMM_AUTOMATION_PLAN.md](CLMM_AUTOMATION_PLAN.md): Architectural specification, math, and execution roadmap.
- `move/`:
  - `move/Move.toml` & `move/Published.toml`: Sui Move 2024 package config and Mainnet (`version = 4`) / Testnet manifests.
  - `move/sources/vault.move`: Shared `Vault`, `VaultShare`, `OperatorCap`/`VaultAdminCap`, hot-potato rebalance custody, and permissionless Cetus/Turbos active LP functions.
  - `move/tests/vault_tests.move`: 36 unit & adversarial security tests.
  - `move/vendor/`: Vendored Mainnet Cetus, Turbos, `integer_mate`, and `move_stl` interfaces for Move builds/tests.
- `public/index.html`: Live web dApp UI (Wallet Standard + Slush multi-account picker, CLMM monitor, Bluefin margin capacity & Zap-In/Zap-Out controls).
- `src/`:
  - `src/start_production.mjs`: Production supervisor running the web server + autonomous monitor together.
  - `src/server.mjs`: Dashboard REST API (`/api/status`, `/api/vault/deposit/*`, `/api/vault/withdraw/*`), PTB preparation, and instant post-tx Bluefin hedge sync.
  - `src/services/monitor.mjs`: Dual-DEX autonomous monitoring & atomic rebalance daemon.
  - `src/ptb/cetusRebalanceBuilder.mjs` & `src/ptb/rebalanceBuilder.mjs`: Atomic Cetus & Turbos rebalance, Zap-In, and 100% USDC Zap-Out PTB builders.
  - `src/services/cetus.mjs`, `src/services/turbos.mjs`, `src/services/bluefin.mjs`: On-chain Cetus/Turbos adapters & Bluefin Pro `SUI-PERP` execution/funding engine.
  - `src/hedging/hedgingEngine.mjs` & `src/hedging/deltaMath.mjs`: Multi-vault delta synchronization and margin health calculation.
  - `src/strategy/rebalanceMath.mjs`: CLMM tick math, dynamic APR estimation, and Q64.64 `sqrtPriceLimit` slippage bounds.
  - `src/compat/suiClientHook.mjs`: Node 24 ESM compatibility hook bridging legacy `@mysten/sui` v1 exports for Cetus SDK.

---

## 🛠️ Quickstart

### 1. Install dependencies & configure `.env`
```bash
npm install
cp .env.example .env
```

### 2. Run Commands
```bash
# Launch production supervisor (web dashboard + autonomous monitor)
npm run start:prod

# Launch only the web dashboard locally (http://localhost:3000)
npm run web

# Run continuous monitor daemon (or single cycle)
npm run monitor
npm run monitor:once

# Run Move 2024 unit & adversarial test suite
sui move test --build-env mainnet --path move

# Simulate Bluefin delta re-hedge or CLMM rebalance drift
npm run simulate:hedge
npm run simulate:drift
```
