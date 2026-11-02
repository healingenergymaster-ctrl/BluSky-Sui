// src/config.mjs
// Central Configuration for BluSky-Sui Protocol

import dotenv from 'dotenv';
dotenv.config();

export const SUI_CONFIG = {
  network: process.env.SUI_NETWORK || 'mainnet',
  rpcUrl: process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443',
  fallbackRpcUrl: process.env.SUI_FALLBACK_RPC || 'https://sui-mainnet-rpc.allthatnode.com',
  
  // Execution Mode: 'DRY_RUN' (safe simulation) or 'LIVE' (real on-chain transactions)
  executionMode: (process.env.EXECUTION_MODE || 'DRY_RUN').toUpperCase(),

  // Wallet
  privateKey: process.env.SUI_PRIVATE_KEY || '',

  // Optional: Specific Position NFT to monitor/rebalance. If blank, monitors all user positions.
  targetPositionNft: process.env.TARGET_POSITION_NFT || '',

  // Known Core Mainnet Objects & Coins
  coins: {
    SUI: '0x2::sui::SUI',
    USDC: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC', // Native Circle USDC
    WUSDC: '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d257a9dc4::coin::COIN' // Wormhole bridged USDC
  },

  decimals: {
    SUI: 9,
    USDC: 6,
    WUSDC: 6
  },

  // Target DEX Pools
  pools: {
    turbos_sui_usdc: process.env.TURBOS_SUI_USDC_POOL || '0x5eb2dfcdd1b1552029717180891a9019a77212783a03460e536452f45f95b6ec',
    bluefin_sui_usdc: process.env.BLUEFIN_SUI_USDC_POOL || ''
  },

  // Strategy Parameters
  strategy: {
    // Trigger rebalance when price is within X% of the range boundaries
    driftThresholdPct: Number(process.env.DRIFT_THRESHOLD_PCT || 15),
    // Target width for new positions: e.g. 10 means ±10% around current spot price
    targetBandWidthPct: Number(process.env.TARGET_BAND_WIDTH_PCT || 10),
    // Minimum accrued fees (USD) before auto-compounding / rebalancing is triggered
    minFeesBeforeRebalanceUsd: Number(process.env.MIN_FEES_BEFORE_REBALANCE_USD || 10.0),
    // Max rebalance cost ratio: gas + swap slippage must not exceed 20% of accrued fees
    maxCostToFeeRatio: Number(process.env.MAX_COST_TO_FEE_RATIO || 0.20),
    // Maximum allowed swap slippage percentage
    maxSlippagePct: Number(process.env.MAX_SLIPPAGE_PCT || 0.5),
    // Polling interval in milliseconds
    checkIntervalMs: Number(process.env.CHECK_INTERVAL_MS || 30000)
  },

  // Phase 2: Bluefin Delta-Neutral Hedging Parameters
  hedging: {
    enabled: process.env.HEDGING_ENABLED !== 'false',
    market: 'SUI-PERP',
    targetLeverage: Number(process.env.HEDGE_LEVERAGE || 1.0), // 1x Short
    deltaDriftTolerancePct: Number(process.env.DELTA_DRIFT_TOLERANCE_PCT || 5.0), // Re-hedge when delta drifts >5%
    rehedgeMinSuiAmount: Number(process.env.REHEDGE_MIN_SUI_AMOUNT || 10.0), // Minimum adjustment size in SUI
    fundingRateIntervalHours: 8
  }
};
