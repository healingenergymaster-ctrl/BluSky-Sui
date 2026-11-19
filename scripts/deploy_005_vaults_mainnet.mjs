// scripts/deploy_005_vaults_mainnet.mjs
// Creates, seeds (~1.00 USDC + ~1.50 SUI each), deploys ±10% positions, and dry-run verifies
// BOTH high-yield Mainnet vaults:
//   1. BluSky Cetus 0.05% SUI/USDC Vault  (pool 0x51e883...)
//   2. BluSky Turbos 0.05% SUI/USDC Vault (pool 0x0df4f0...)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import BN from 'bn.js';
import { ClmmPoolUtil } from '@cetusprotocol/cetus-sui-clmm-sdk/dist/index.mjs';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { WalletManager } from '../src/services/wallet.mjs';
import { SUI_CONFIG } from '../src/config.mjs';
import { CetusService } from '../src/services/cetus.mjs';
import { TurbosService } from '../src/services/turbos.mjs';
import { CetusRebalancePtbBuilder } from '../src/ptb/cetusRebalanceBuilder.mjs';
import { TurbosRebalancePtbBuilder } from '../src/ptb/rebalanceBuilder.mjs';
import { computeTargetTickRange, computeCetusFlashSwapAndAddPlan } from '../src/strategy/rebalanceMath.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const envPath = path.join(rootDir, '.env');

dotenv.config({ path: envPath, override: true });

function unwrapTx(res, label) {
  const txObj = res.$kind === 'Transaction' ? res.Transaction : res.FailedTransaction;
  if (res.$kind === 'FailedTransaction' || !txObj?.status?.success) {
    throw new Error(`${label} failed (digest=${txObj?.digest}): ${JSON.stringify(txObj?.status?.error || res)}`);
  }
  return txObj;
}

function upsertEnvVars(updates) {
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  for (const [key, val] of Object.entries(updates)) {
    const line = `${key}=${val}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(content)) {
      content = content.replace(re, line);
    } else {
      if (content && !content.endsWith('\n')) content += '\n';
      content += `${line}\n`;
    }
  }
  fs.writeFileSync(envPath, content, 'utf8');
}

async function createAndSeedVault({
  label,
  envPrefix,
  dexService,
  coinTypeA,
  coinTypeB,
  initDepositRawA,
  initDepositRawB,
  callPackageId,
  grpcClient,
  keypair,
  sender
}) {
  let vaultId = process.env[`${envPrefix}_VAULT_OBJECT_ID`] || '';
  let operatorCapId = process.env[`${envPrefix}_VAULT_OPERATOR_CAP`] || '';
  let adminCapId = process.env[`${envPrefix}_VAULT_ADMIN_CAP`] || '';
  let snap = null;

  if (vaultId && operatorCapId) {
    snap = await dexService.getVaultSnapshot(vaultId).catch(() => null);
    if (snap) {
      console.log(`🏛️ [${label}] Reusing existing vault ${vaultId} (shares=${snap.totalShares}, pos=${snap.positionNftId || 'none'})`);
    } else {
      vaultId = '';
    }
  }

  if (!vaultId) {
    console.log(`\n🚀 [${label}] Creating shared Vault<${coinTypeA.split('::').pop()}, ${coinTypeB.split('::').pop()}>...`);
    const tx = new Transaction();
    tx.setSender(sender);
    tx.setGasBudget(50_000_000);
    tx.moveCall({
      target: `${callPackageId}::vault::create_vault`,
      typeArguments: [coinTypeA, coinTypeB],
      arguments: [tx.pure.u64(1000n), tx.pure.address(SUI_CONFIG.feeTreasuryAddress)]
    });
    const res = await grpcClient.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      include: { effects: true, objectTypes: true }
    });
    const ok = unwrapTx(res, `${label} create_vault`);
    await grpcClient.waitForTransaction({ digest: ok.digest });

    for (const [objId, objType] of Object.entries(ok.objectTypes || {})) {
      if (objType.includes('::vault::Vault<')) vaultId = objId;
      else if (objType.includes('::vault::OperatorCap')) operatorCapId = objId;
      else if (objType.includes('::vault::VaultAdminCap')) adminCapId = objId;
    }
    if (!vaultId || !operatorCapId) {
      throw new Error(`[${label}] Could not extract Vault / OperatorCap from tx ${ok.digest}`);
    }

    process.env[`${envPrefix}_VAULT_OBJECT_ID`] = vaultId;
    process.env[`${envPrefix}_VAULT_OPERATOR_CAP`] = operatorCapId;
    process.env[`${envPrefix}_VAULT_ADMIN_CAP`] = adminCapId || '';
    upsertEnvVars({
      [`${envPrefix}_VAULT_OBJECT_ID`]: vaultId,
      [`${envPrefix}_VAULT_OPERATOR_CAP`]: operatorCapId,
      [`${envPrefix}_VAULT_ADMIN_CAP`]: adminCapId || ''
    });

    console.log(`   ✅ Vault Created: ${vaultId} (tx: ${ok.digest})`);
    console.log(`      OperatorCap: ${operatorCapId}`);
    snap = await dexService.getVaultSnapshot(vaultId);
  }

  if (snap.totalShares === 0n) {
    console.log(`💰 [${label}] Seeding pilot deposit (rawA=${initDepositRawA}, rawB=${initDepositRawB})...`);
    const depTx = new Transaction();
    depTx.setSender(sender);
    depTx.setGasBudget(60_000_000);
    const coinA = coinWithBalance({ type: coinTypeA, balance: initDepositRawA });
    const coinB = coinWithBalance({ type: coinTypeB, balance: initDepositRawB });
    const [shareObj] = depTx.moveCall({
      target: `${callPackageId}::vault::deposit`,
      typeArguments: [coinTypeA, coinTypeB],
      arguments: [depTx.object(vaultId), coinA, coinB]
    });
    depTx.transferObjects([shareObj], sender);

    const resDep = await grpcClient.signAndExecuteTransaction({
      transaction: depTx,
      signer: keypair,
      include: { effects: true, objectTypes: true }
    });
    const okDep = unwrapTx(resDep, `${label} pilot deposit`);
    await grpcClient.waitForTransaction({ digest: okDep.digest });
    console.log(`   ✅ Pilot Seeded! Digest: ${okDep.digest}`);
    snap = await dexService.getVaultSnapshot(vaultId);
  }

  return { vaultId, operatorCapId, adminCapId, snap };
}

async function main() {
  console.log('=================================================================');
  console.log('🚀 BluSky-Sui — DEPLOY 0.05% CETUS & TURBOS VAULTS (MAINNET)');
  console.log('=================================================================\n');

  const wallet = new WalletManager(process.env.SUI_PRIVATE_KEY);
  if (!wallet.isConfigured()) throw new Error('SUI_PRIVATE_KEY missing');
  const keypair = wallet.getKeypair();
  const sender = wallet.getAddress();
  const callPackageId = SUI_CONFIG.vault.callPackageId || SUI_CONFIG.vault.packageId;

  const cetusService = new CetusService('mainnet');
  const turbosService = new TurbosService('mainnet');
  const grpcClient = cetusService.getGrpcClient();
  const cetusPtb = new CetusRebalancePtbBuilder(cetusService);
  const turbosPtb = new TurbosRebalancePtbBuilder(turbosService);
  const signer = { getKeypair: () => keypair, getGrpcClient: () => grpcClient };

  console.log(`👛 Operator: ${sender}`);
  console.log(`📦 Vault Call Package: ${callPackageId}`);

  // -----------------------------------------------------------------
  // 1. Deploy Cetus 0.05% Vault (0x51e883...)
  // -----------------------------------------------------------------
  const cetusPoolId = SUI_CONFIG.pools.cetus_sui_usdc_tight;
  const cetusPool = await cetusService.getPool(cetusPoolId);
  if (cetusPool.isSimulated) throw new Error('Cetus 0.05% pool read failed');
  console.log(`\n🌊 [Cetus 0.05%] Pool ${cetusPoolId} | spot=$${cetusPool.currentPrice.toFixed(4)} | tick=${cetusPool.currentTick} | spacing=${cetusPool.tickSpacing}`);

  const cetusSeedUsdc = 1_000_000n;     // 1.00 USDC
  const cetusSeedSui = 1_500_000_000n;  // 1.50 SUI
  const cetusRes = await createAndSeedVault({
    label: 'Cetus 0.05%',
    envPrefix: 'CETUS005',
    dexService: cetusService,
    coinTypeA: cetusPool.coinTypeA,
    coinTypeB: cetusPool.coinTypeB,
    initDepositRawA: cetusSeedUsdc,
    initDepositRawB: cetusSeedSui,
    callPackageId,
    grpcClient,
    keypair,
    sender
  });

  if (!cetusRes.snap.positionNftId) {
    const band = computeTargetTickRange(
      cetusPool.currentPrice,
      10,
      cetusPool.tickSpacing,
      cetusPool.decimalsA,
      cetusPool.decimalsB,
      cetusPool.isCoinASui
    );
    const probeFixA = ClmmPoolUtil.estLiquidityAndcoinAmountFromOneAmounts(
      band.lowerTick,
      band.upperTick,
      new BN(cetusRes.snap.idleA.toString()),
      true,
      true,
      0,
      new BN(cetusPool.sqrtPriceX64)
    );
    const isFixA = BigInt(probeFixA.coinAmountB.toString()) <= cetusRes.snap.idleB;
    const fixAmount = isFixA ? cetusRes.snap.idleA : cetusRes.snap.idleB;

    console.log(`🚀 [Cetus 0.05%] Deploying initial ±10% position [${band.lowerTick}, ${band.upperTick}] (isFixA=${isFixA}, fix=${fixAmount})...`);
    const deployPtb = await cetusPtb.buildDeployInitialPositionPtb({
      vaultId: cetusRes.vaultId,
      vaultPackageId: callPackageId,
      operatorCapId: cetusRes.operatorCapId,
      poolId: cetusPoolId,
      coinTypeA: cetusPool.coinTypeA,
      coinTypeB: cetusPool.coinTypeB,
      ownerAddress: sender,
      newLowerTick: band.lowerTick,
      newUpperTick: band.upperTick,
      fixAmount,
      isFixA
    });
    const execCetus = await cetusPtb.execute({ ptbResult: deployPtb, signer, forceLive: true });
    console.log(`   ✅ Cetus 0.05% Position Deployed! Digest: ${execCetus.digest}`);
  }
  const cetusSnapFinal = await cetusService.getVaultSnapshot(cetusRes.vaultId);
  console.log(`   📊 Cetus 0.05% Snapshot: nft=${cetusSnapFinal.positionNftId}, LP=${cetusSnapFinal.positionHoldUsdc.toFixed(4)} USDC + ${cetusSnapFinal.positionHoldSui.toFixed(4)} SUI`);

  // Dry-run verify zap deposit on Cetus 0.05%
  const cetusZapDry = await cetusPtb.buildZapDepositPtb({
    userAddress: sender,
    depositUsdcAmount: 1.0,
    vaultSnapshot: cetusSnapFinal,
    vaultId: cetusRes.vaultId,
    vaultCallPackageId: callPackageId,
    operatorCapId: cetusRes.operatorCapId,
    poolId: cetusPoolId
  });
  const cetusZapSim = await cetusPtb.simulateDryRun(cetusZapDry, signer);
  console.log(`   🧪 [Cetus 0.05%] Zap Deposit Dry-Run: success=${cetusZapSim.success}${cetusZapSim.error ? ' err=' + JSON.stringify(cetusZapSim.error) : ''}`);

  // -----------------------------------------------------------------
  // 2. Deploy Turbos 0.05% Vault (0x0df4f0...)
  // -----------------------------------------------------------------
  const turbosPoolId = SUI_CONFIG.pools.turbos_sui_usdc;
  const turbosPool = await turbosService.getPool(turbosPoolId);
  if (turbosPool.isSimulated) throw new Error('Turbos 0.05% pool read failed');
  console.log(`\n🌀 [Turbos 0.05%] Pool ${turbosPoolId} | spot=$${turbosPool.currentPrice.toFixed(4)} | tick=${turbosPool.currentTick} | spacing=${turbosPool.tickSpacing}`);

  const turbosSeedSui = 1_500_000_000n; // 1.50 SUI (CoinA on Turbos)
  const turbosSeedUsdc = 1_000_000n;    // 1.00 USDC (CoinB on Turbos)
  const turbosRes = await createAndSeedVault({
    label: 'Turbos 0.05%',
    envPrefix: 'TURBOS005',
    dexService: turbosService,
    coinTypeA: turbosPool.coinTypeA,
    coinTypeB: turbosPool.coinTypeB,
    initDepositRawA: turbosSeedSui,
    initDepositRawB: turbosSeedUsdc,
    callPackageId,
    grpcClient,
    keypair,
    sender
  });

  if (!turbosRes.snap.positionNftId) {
    const tBand = computeTargetTickRange(
      turbosPool.currentPrice,
      10,
      turbosPool.tickSpacing,
      turbosPool.decimalsA,
      turbosPool.decimalsB,
      turbosPool.isCoinASui
    );
    console.log(`🚀 [Turbos 0.05%] Deploying initial ±10% position [${tBand.lowerTick}, ${tBand.upperTick}]...`);
    const deployTurbosPtb = await turbosPtb.buildDeployInitialPositionPtb({
      vaultId: turbosRes.vaultId,
      vaultPackageId: callPackageId,
      operatorCapId: turbosRes.operatorCapId,
      poolId: turbosPoolId,
      coinTypeA: turbosPool.coinTypeA,
      coinTypeB: turbosPool.coinTypeB,
      feeType: turbosPool.feeType,
      ownerAddress: sender,
      newLowerTick: tBand.lowerTick,
      newUpperTick: tBand.upperTick
    });
    const execTurbos = await turbosPtb.execute({ ptbResult: deployTurbosPtb, signer, forceLive: true });
    console.log(`   ✅ Turbos 0.05% Position Deployed! Digest: ${execTurbos.digest}`);
  }

  const turbosSnapFinal = await turbosService.getVaultSnapshot(turbosRes.vaultId);
  console.log(`   📊 Turbos 0.05% Snapshot: nft=${turbosSnapFinal.positionNftId}, ticks=[${turbosSnapFinal.position?.lowerTick}, ${turbosSnapFinal.position?.upperTick}], LP=${turbosSnapFinal.positionHoldUsdc.toFixed(4)} USDC + ${turbosSnapFinal.positionHoldSui.toFixed(4)} SUI`);

  // Dry-run verify Turbos Zap Deposit + Atomic Rebalance PTBs!
  const turbosZapDry = await turbosPtb.buildZapDepositPtb({
    userAddress: sender,
    depositUsdcAmount: 1.0,
    vaultSnapshot: turbosSnapFinal,
    vaultId: turbosRes.vaultId,
    vaultCallPackageId: callPackageId,
    operatorCapId: turbosRes.operatorCapId,
    poolId: turbosPoolId
  });
  const turbosZapSim = await turbosPtb.simulateDryRun(turbosZapDry, signer);
  console.log(`   🧪 [Turbos 0.05%] Zap Deposit Dry-Run: success=${turbosZapSim.success}${turbosZapSim.error ? ' err=' + JSON.stringify(turbosZapSim.error) : ''}`);

  const rebalBand = computeTargetTickRange(
    turbosPool.currentPrice,
    8,
    turbosPool.tickSpacing,
    turbosPool.decimalsA,
    turbosPool.decimalsB,
    turbosPool.isCoinASui
  );
  const rebalSwap = computeCetusFlashSwapAndAddPlan({
    rawCoinA: turbosSnapFinal.totalRawA,
    rawCoinB: turbosSnapFinal.totalRawB,
    poolSqrtPriceX64: turbosPool.sqrtPriceX64,
    poolLiquidity: turbosPool.liquidity,
    lowerTick: rebalBand.lowerTick,
    upperTick: rebalBand.upperTick,
    feeRateBps: turbosPool.fee || 500,
    safetyBufferPct: 1.5
  });
  const turbosRebalDry = await turbosPtb.buildAtomicRebalancePtb({
    poolId: turbosPoolId,
    positionNftId: turbosSnapFinal.positionNftId,
    ownerAddress: sender,
    currentTick: turbosPool.currentTick,
    newLowerTick: rebalBand.lowerTick,
    newUpperTick: rebalBand.upperTick,
    swapPlan: rebalSwap,
    vaultId: turbosRes.vaultId,
    vaultPackageId: callPackageId,
    operatorCapId: turbosRes.operatorCapId,
    coinTypeA: turbosSnapFinal.coinTypeA,
    coinTypeB: turbosSnapFinal.coinTypeB,
    feeType: turbosPool.feeType,
    positionLiquidity: turbosSnapFinal.position?.liquidity || '0',
    rewarderDetails: turbosPool.rewarderDetails || [],
    isLiveRebalance: true
  });
  const turbosRebalSim = await turbosPtb.simulateDryRun(turbosRebalDry, signer);
  console.log(`   🧪 [Turbos 0.05%] Atomic Rebalance Dry-Run: success=${turbosRebalSim.success}${turbosRebalSim.error ? ' err=' + JSON.stringify(turbosRebalSim.error) : ''}`);

  upsertEnvVars({ DEFAULT_VAULT_KEY: 'cetus005' });

  console.log('\n=================================================================');
  console.log('🎉 BOTH 0.05% MAINNET VAULTS DEPLOYED & VERIFIED!');
  console.log(`   CETUS005_VAULT_OBJECT_ID=${cetusRes.vaultId}`);
  console.log(`   TURBOS005_VAULT_OBJECT_ID=${turbosRes.vaultId}`);
  console.log('=================================================================');
}

main().catch((err) => {
  console.error('\n❌ Deploy failed:', err);
  process.exit(1);
});

