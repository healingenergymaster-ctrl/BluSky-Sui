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
    packageId: process.env.VAULT_PACKAGE_ID || '0x9012c6d5deddf25d936ffe5aeadc6849c9488223e7f81cb54f8faced78d23844',
    objectId: process.env.VAULT_OBJECT_ID || '0x630639ff9b39e8515ce648202a3d919d95ab421aa1f2f6903875964fed0708dc',
    adminCap: process.env.VAULT_ADMIN_CAP || '0x137b746c5a05111463c49a6cd0ee8d641679a207c1cfef5d0700cb3f66b5e976',
    operatorCap: process.env.VAULT_OPERATOR_CAP || '0x2ba5abe25e4373e72b17c503c3033b83116735714ae4ab179ebd62b5fc64c6c6',
    upgradeCap: process.env.VAULT_UPGRADE_CAP || '0x37fa2800fc91802c59e2ed4877497211e78cbe68e1644dbd5bca36eb425cd9d8'
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
