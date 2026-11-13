// src/config.mjs
// Central Configuration for BluSky-Sui Protocol

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Load default .env first
dotenv.config();

// If SUI_NETWORK is testnet or argument contains --testnet, load .env.testnet overrides
const isTestnetMode = process.env.SUI_NETWORK === 'testnet' || process.argv.includes('--testnet');
if (isTestnetMode && fs.existsSync(path.join(rootDir, '.env.testnet'))) {
  dotenv.config({ path: path.join(rootDir, '.env.testnet'), override: true });
}

const network = process.env.SUI_NETWORK || (isTestnetMode ? 'testnet' : 'mainnet');
const isTestnet = network === 'testnet';

export const SUI_CONFIG = {
  network,
  isTestnet,
  rpcUrl: process.env.SUI_RPC_URL || (isTestnet ? 'https://fullnode.testnet.sui.io:443' : 'https://fullnode.mainnet.sui.io:443'),
  graphqlUrl: process.env.SUI_GRAPHQL_URL || (isTestnet ? 'https://graphql.testnet.sui.io/graphql' : 'https://graphql.mainnet.sui.io/graphql'),
  fallbackRpcUrl: process.env.SUI_FALLBACK_RPC || (isTestnet ? 'https://testnet.sui.rpcpool.com' : 'https://sui-mainnet-rpc.allthatnode.com'),
  
  // Protocol Monetization Treasury
  feeTreasuryAddress: process.env.FEE_TREASURY_ADDRESS || '0xa81ad397c3aadae2ddcfde5cef96aa21d4f445c918f8d819c5ea757aafa8f6db',
  
  // Execution Mode: 'DRY_RUN' (safe simulation) or 'LIVE' (real on-chain transactions)
  executionMode: (process.env.EXECUTION_MODE || 'DRY_RUN').toUpperCase(),

  // Wallet
  privateKey: process.env.SUI_PRIVATE_KEY || '',

  // Optional: Specific Position NFT to monitor/rebalance. If blank, monitors all user positions.
  targetPositionNft: process.env.TARGET_POSITION_NFT || '',

  // On-Chain Vault Deployment (Published Move Package & Shared Object)
  vault: {
    packageId: process.env.VAULT_PACKAGE_ID || '0xdbc40c8e2c8fce1e9d9e401725567bd07f841644ee0f78f73f7d2c6831487f30',
    objectId: process.env.VAULT_OBJECT_ID || '0x349690a26474c0b6441ad9392e15015e286899c11f49105c25b7e8036e24bd66',
    adminCap: process.env.VAULT_ADMIN_CAP || '0x7266318ecabcb09f4fd97bb33e75576ee3cf125deb952427de959db0eda7b4e5',
    operatorCap: process.env.VAULT_OPERATOR_CAP || '0x1589848a2fd5a8054bc9d281a8628cf8d6afe43e29b6803b1bd4b9b117ae2cc3',
    upgradeCap: process.env.VAULT_UPGRADE_CAP || '0x23a6d43eaffc2f1156f749d42e2b5610d8a3cd7de6bc1026706ec32240cff16f'
  },

  // Known Core Objects & Coins (Testnet vs Mainnet)
  coins: {
    SUI: '0x2::sui::SUI',
    USDC: isTestnet
      ? (process.env.TESTNET_USDC_COIN_TYPE || '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC')
      : '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC', // Native Circle USDC
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
    cetus_sui_usdc: process.env.CETUS_SUI_USDC_POOL || (isTestnet ? '0xf4cac8c2720d1d250cfe50011e108db73fd3b4e9caf84fb6283ef3020b9ef576' : '0xc8d7a1503dc509f80e611a31881748a59e7591060e495e803fa70016ff2572dd'),
    cetus_sui_usdc_tight: '0x2e041f3fd9202309ce711a7bac9316b8ebb16d62cc9ab4d0e4085f32d022b927',
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
  },

  // Smart Yield Routing (Dual-DEX Cetus + Turbos)
  yieldRouting: {
    enabled: process.env.YIELD_ROUTING_ENABLED !== 'false',
    minAprSpreadPct: Number(process.env.YIELD_ROUTING_MIN_SPREAD_PCT || 15.0), // 15% net APR spread required
    spreadCooldownHours: Number(process.env.YIELD_ROUTING_COOLDOWN_HOURS || 24),
    primaryDex: process.env.PRIMARY_DEX || 'cetus' // 'cetus' or 'turbos'
  }
};
