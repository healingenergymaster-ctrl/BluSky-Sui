// scripts/test_live_cetus_flashswap.mjs
// Pre-Flight Verification:
// 1. Verifies live Mainnet Cetus v15 config & flagship Native USDC/SUI pool read (zero gas)
// 2. Executes a LIVE Testnet dual-sided rebalance WITH on-chain pool::flash_swap (SUI -> USDC)
//    turning a 100% single-sided SUI position into a centered two-sided USDC+SUI position!

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(rootDir, '.env.testnet'), override: true });

const { SUI_CONFIG } = await import('../src/config.mjs');
const { CetusService } = await import('../src/services/cetus.mjs');
const { CetusRebalancePtbBuilder } = await import('../src/ptb/cetusRebalanceBuilder.mjs');
const { computeCetusFlashSwapAndAddPlan } = await import('../src/strategy/rebalanceMath.mjs');

function loadKeypairFromEnv() {
  const raw = process.env.SUI_PRIVATE_KEY;
  if (!raw) throw new Error('Missing SUI_PRIVATE_KEY in .env.testnet');
  if (raw.startsWith('suiprivkey')) {
    return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(raw).secretKey);
  }
  const clean = raw.replace(/^0x/, '');
  const bytes = /^[0-9a-fA-F]{64}$/.test(clean)
    ? Uint8Array.from(Buffer.from(clean, 'hex'))
    : Uint8Array.from(Buffer.from(raw, 'base64'));
  return Ed25519Keypair.fromSecretKey(bytes.length === 33 ? bytes.slice(1) : bytes);
}

async function main() {
  console.log('=================================================================');
  console.log('🧪 BluSky-Sui — Pre-Flight Mainnet Pool Check + Live Flash-Swap');
  console.log('=================================================================\n');

  // 1. Verify Mainnet Cetus v15 pool read via gRPC (read-only, zero funds)
  const mainnetCetus = new CetusService('mainnet');
  const mainnetPool = await mainnetCetus.getPool();
  if (mainnetPool.isSimulated) {
    throw new Error('Mainnet Cetus pool fetch fell back to simulation');
  }
  console.log('✅ Mainnet Cetus Pool Verified Live via Sui gRPC:');
  console.log(`   Pool ID:      ${mainnetPool.objectId}`);
  console.log(`   CoinA / B:    ${mainnetPool.coinTypeA.slice(-15)} / ${mainnetPool.coinTypeB.slice(-12)}`);
  console.log(`   Spot Price:   $${mainnetPool.currentPrice.toFixed(4)} USDC/SUI (tick ${mainnetPool.currentTick}, spacing ${mainnetPool.tickSpacing})`);
  console.log(`   v15 Package:  ${mainnetCetus.contracts.publishedAt}\n`);

  // 2. Testnet live dual-sided flash_swap + centered rebalance on existing Vault v2
  const keypair = loadKeypairFromEnv();
  const sender = keypair.toSuiAddress();
  const testnetCetus = new CetusService('testnet');
  const grpcClient = testnetCetus.getGrpcClient();
  const ptbBuilder = new CetusRebalancePtbBuilder(testnetCetus);
  const signer = { getKeypair: () => keypair, getGrpcClient: () => grpcClient };

  const vaultId = SUI_CONFIG.vault.objectId;
  const operatorCapId = SUI_CONFIG.vault.operatorCap;
  const before = await testnetCetus.getVaultSnapshot(vaultId);
  if (!before || !before.positionNftId) {
    throw new Error(`Vault ${vaultId} has no active position to rebalance`);
  }

  console.log('📦 Testnet Vault Snapshot BEFORE Flash-Swap Rebalance:');
  console.log(`   Vault ID:      ${before.vaultId}`);
  console.log(`   Old Position:  ${before.positionNftId}`);
  console.log(`   Current Ticks: [${before.currentLowerTick}, ${before.currentUpperTick}] (Pool Spot Tick = ${before.pool.currentTick})`);
  console.log(`   Total Raw A/B: ${before.totalRawA} USDC_raw, ${before.totalRawB} MIST\n`);

  // Pick a centered range straddling pool.currentTick
  const spacing = before.pool.tickSpacing || 2;
  const align = (t) => Math.floor(t / spacing) * spacing;
  const targetLower = align(before.pool.currentTick - 400);
  const targetUpper = align(before.pool.currentTick + 400);

  const swapPlan = computeCetusFlashSwapAndAddPlan({
    rawCoinA: before.totalRawA,
    rawCoinB: before.totalRawB,
    poolSqrtPriceX64: before.pool.sqrtPriceX64,
    poolLiquidity: before.pool.liquidity,
    lowerTick: targetLower,
    upperTick: targetUpper,
    feeRateBps: before.pool.feeRate,
    safetyBufferPct: 5.0
  });

  console.log(`🔄 Computed Atomic Flash-Swap + Centered Range [${targetLower}, ${targetUpper}]:`);
  console.log(`   executeOnChain: ${swapPlan.executeOnChain}, a2b: ${swapPlan.a2b}, swapAmountRaw: ${swapPlan.swapAmountRaw}`);
  console.log(`   isFixA: ${swapPlan.isFixA}, redeployFixAmount: ${swapPlan.redeployFixAmount}\n`);

  const ptbResult = await ptbBuilder.buildAtomicRebalancePtb({
    poolId: before.pool.objectId,
    positionNftId: before.positionNftId,
    ownerAddress: sender,
    currentTick: before.pool.currentTick,
    newLowerTick: targetLower,
    newUpperTick: targetUpper,
    swapPlan,
    vaultId: before.vaultId,
    vaultPackageId: SUI_CONFIG.vault.packageId,
    operatorCapId,
    coinTypeA: before.coinTypeA,
    coinTypeB: before.coinTypeB,
    redeployFixAmount: swapPlan.redeployFixAmount,
    isFixA: swapPlan.isFixA,
    isLiveRebalance: true
  });

  console.log('🚀 Executing LIVE Flash-Swap + Dual-Sided Atomic Rebalance PTB on Testnet...');
  const exec = await ptbBuilder.execute({ ptbResult, signer, forceLive: true });
  const after = await testnetCetus.getVaultSnapshot(vaultId);

  console.log(`   ✅ SUCCEEDED! Digest: ${exec.digest}`);
  console.log(`      🔗 https://suiscan.xyz/testnet/tx/${exec.digest}`);
  console.log(`      New Position NFT:    ${after.positionNftId}`);
  console.log(`      Updated Ticks:       [${after.currentLowerTick}, ${after.currentUpperTick}]`);
  console.log(`      Position Held Raw A: ${after.positionAmounts.amountA} microUSDC`);
  console.log(`      Position Held Raw B: ${after.positionAmounts.amountB} MIST SUI`);
  console.log(`      Vault Idle Raw A/B:  ${after.idleA} / ${after.idleB}`);

  if (after.positionAmounts.amountA <= 0n || after.positionAmounts.amountB <= 0n) {
    throw new Error('Expected BOTH CoinA (USDC) and CoinB (SUI) active in centered dual-sided position!');
  }

  console.log('\n🏁 DUAL-SIDED FLASH-SWAP + CENTERED LP REBALANCE VERIFIED ON TESTNET!');
}

main().catch((err) => {
  console.error('\n❌ Pre-flight flash-swap verification failed:', err);
  process.exit(1);
});
