// scripts/deploy_and_test_mainnet.mjs
// Production (Sui Mainnet) Small Pilot Deployment & End-to-End Live Test:
// 1. Compiles & publishes blusky_vault Move v2 package to Sui Mainnet (reusing if VAULT_PACKAGE_ID already deployed on Mainnet)
// 2. Creates a production Vault<USDC, SUI>
// 3. Deposits a small pilot test allocation: 1.00 USDC + 1.00 SUI (~$1.80 total)
// 4. Deploys initial Cetus v15 Position NFT on flagship 0.25% USDC/SUI pool centered ±10%
// 5. Executes a full 7-step Atomic Rebalance PTB recentering to ±8% (with flash_swap if needed)
// 6. Records Mainnet Package/Vault/Cap IDs into .env & move/Published.toml

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import BN from 'bn.js';
import { ClmmPoolUtil } from '@cetusprotocol/cetus-sui-clmm-sdk/dist/index.mjs';
import { Transaction } from '@mysten/sui/transactions';
import { WalletManager } from '../src/services/wallet.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const envPath = path.join(rootDir, '.env');
const publishedTomlPath = path.join(rootDir, 'move', 'Published.toml');

dotenv.config({ path: envPath, override: true });

const { SUI_CONFIG } = await import('../src/config.mjs');
const { CetusService } = await import('../src/services/cetus.mjs');
const { CetusRebalancePtbBuilder } = await import('../src/ptb/cetusRebalanceBuilder.mjs');
const { computeTargetTickRange, computeCetusFlashSwapAndAddPlan } = await import('../src/strategy/rebalanceMath.mjs');

function getSuiCli() {
  const candidates = [
    'sui',
    path.join(process.env.USERPROFILE || 'C:\\Users\\crypt', '.cargo', 'bin', 'sui.exe')
  ];
  for (const c of candidates) {
    try {
      execSync(`"${c}" --version`, { stdio: 'pipe' });
      return c;
    } catch (_) {}
  }
  throw new Error('Sui CLI binary not found');
}

function unwrapTx(res) {
  const txObj = res.$kind === 'Transaction' ? res.Transaction : res.FailedTransaction;
  if (res.$kind === 'FailedTransaction' || !txObj?.status?.success) {
    throw new Error(`Mainnet tx failed (digest=${txObj?.digest}): ${JSON.stringify(txObj?.status?.error || res)}`);
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

function upsertPublishedMainnet(packageId, upgradeCapId) {
  let toml = fs.existsSync(publishedTomlPath) ? fs.readFileSync(publishedTomlPath, 'utf8') : '';
  if (toml.includes('[published.mainnet]')) return;
  const block = `\n[published.mainnet]\nchain-id = "35834a8a"\npublished-at = "${packageId}"\noriginal-id = "${packageId}"\nversion = 1\ntoolchain-version = "1.83.1"\nbuild-config = { flavor = "sui", edition = "2024" }\nupgrade-capability = "${upgradeCapId}"\n`;
  fs.writeFileSync(publishedTomlPath, `${toml.trimEnd()}\n${block}`, 'utf8');
}

async function main() {
  console.log('=================================================================');
  console.log('🌐 BluSky-Sui — PRODUCTION (SUI MAINNET) PILOT DEPLOY & TEST');
  console.log('=================================================================\n');

  const wallet = new WalletManager(process.env.SUI_PRIVATE_KEY);
  if (!wallet.isConfigured()) {
    throw new Error('SUI_PRIVATE_KEY is missing or invalid in .env');
  }

  const keypair = wallet.getKeypair();
  const sender = wallet.getAddress();
  const cetusService = new CetusService('mainnet');
  const grpcClient = cetusService.getGrpcClient();
  const ptbBuilder = new CetusRebalancePtbBuilder(cetusService);
  const signer = { getKeypair: () => keypair, getGrpcClient: () => grpcClient };

  console.log(`👛 Mainnet Operator Wallet: ${sender}`);
  const balances = await grpcClient.listBalances({ owner: sender });
  const suiBal = balances.balances.find(b => b.coinType.endsWith('::sui::SUI'));
  const usdcBal = balances.balances.find(b => b.coinType === SUI_CONFIG.coins.USDC);
  console.log(`💰 Mainnet SUI Balance:     ${(Number(suiBal?.balance || 0) / 1e9).toFixed(4)} SUI`);
  console.log(`💵 Mainnet Native USDC:     ${(Number(usdcBal?.balance || 0) / 1e6).toFixed(4)} USDC\n`);

  if (Number(suiBal?.balance || 0) < 2_000_000_000) {
    throw new Error('Need at least 2.0 SUI on Mainnet for safe publish + pilot deposit + gas');
  }
  if (Number(usdcBal?.balance || 0) < 1_000_000) {
    throw new Error('Need at least 1.00 Native USDC on Mainnet for the pilot test');
  }

  // Fetch flagship Mainnet Cetus 0.25% USDC/SUI pool
  const poolId = SUI_CONFIG.pools.cetus_sui_usdc;
  const pool = await cetusService.getPool(poolId);
  if (pool.isSimulated) throw new Error('Mainnet Cetus pool read failed');
  console.log(`🌊 Mainnet Cetus Pool: ${pool.objectId}`);
  console.log(`   CoinA: ${pool.coinTypeA}`);
  console.log(`   CoinB: ${pool.coinTypeB}`);
  console.log(`   Spot:  $${pool.currentPrice.toFixed(4)} USDC/SUI (tick ${pool.currentTick}, spacing ${pool.tickSpacing})\n`);

  // -----------------------------------------------------------------
  // TX 1: Publish Move Package to Mainnet (or reuse if already in .env)
  // -----------------------------------------------------------------
  let packageId = process.env.VAULT_PACKAGE_ID || '';
  let upgradeCapId = process.env.VAULT_UPGRADE_CAP || '';
  let publishDigest = null;

  if (packageId) {
    try {
      await grpcClient.getObject({ objectId: packageId });
      console.log(`📦 Reusing existing Mainnet Package ID from .env: ${packageId}\n`);
    } catch (_) {
      packageId = '';
    }
  }

  if (!packageId) {
    console.log('🔨 Building blusky_vault Move bytecode for Sui Mainnet...');
    const suiCli = getSuiCli();
    const buildOut = execSync(`"${suiCli}" move build --dump-bytecode-as-base64 --path move`, {
      cwd: rootDir,
      encoding: 'utf8'
    });
    const jsonLine = buildOut.slice(buildOut.lastIndexOf('{"modules":'));
    const compiled = JSON.parse(jsonLine);

    console.log('🚀 [Tx 1] Publishing blusky_vault v2 to Sui Mainnet...');
    const pubTx = new Transaction();
    pubTx.setSender(sender);
    pubTx.setGasBudget(250_000_000);
    const [upgradeCap] = pubTx.publish({
      modules: compiled.modules,
      dependencies: compiled.dependencies
    });
    pubTx.transferObjects([upgradeCap], sender);

    const pubRes = await grpcClient.signAndExecuteTransaction({
      transaction: pubTx,
      signer: keypair,
      include: { effects: true, objectTypes: true }
    });
    const pubOk = unwrapTx(pubRes);
    await grpcClient.waitForTransaction({ digest: pubOk.digest });
    publishDigest = pubOk.digest;

    const pkgChange = (pubOk.effects?.changedObjects || []).find(
      c => c.idOperation === 'Created' && c.outputState === 'PackageWrite'
    );
    packageId = pkgChange?.objectId;
    upgradeCapId = Object.entries(pubOk.objectTypes || {}).find(([, t]) =>
      t.endsWith('::package::UpgradeCap')
    )?.[0];

    if (!packageId) throw new Error('Could not extract published Package ID from Mainnet tx effects');

    upsertPublishedMainnet(packageId, upgradeCapId || '');
    upsertEnvVars({
      VAULT_PACKAGE_ID: packageId,
      VAULT_UPGRADE_CAP: upgradeCapId || '',
      HEDGING_ENABLED: 'false'
    });

    console.log(`   ✅ Mainnet Package Published! Digest: ${publishDigest}`);
    console.log(`      Package ID:  ${packageId}`);
    console.log(`      UpgradeCap:  ${upgradeCapId}`);
    console.log(`      🔗 https://suiscan.xyz/mainnet/tx/${publishDigest}\n`);
  }

  // -----------------------------------------------------------------
  // TX 2: Create Production Vault<USDC, SUI> (or reuse existing in .env)
  // -----------------------------------------------------------------
  let vaultId = process.env.VAULT_OBJECT_ID || null;
  let operatorCapId = process.env.VAULT_OPERATOR_CAP || null;
  let adminCapId = process.env.VAULT_ADMIN_CAP || null;
  let snapAfterDeploy = null;

  if (vaultId && operatorCapId) {
    snapAfterDeploy = await cetusService.getVaultSnapshot(vaultId).catch(() => null);
    if (snapAfterDeploy) {
      console.log(`🏛️ Reusing existing Mainnet Vault from .env: ${vaultId} (shares=${snapAfterDeploy.totalShares}, pos=${snapAfterDeploy.positionNftId || 'none'})\n`);
    } else {
      vaultId = null;
    }
  }

  if (!vaultId) {
    console.log('🚀 [Tx 2] Creating Production Vault<USDC, SUI> on Sui Mainnet...');
    const tx2 = new Transaction();
    tx2.setSender(sender);
    tx2.setGasBudget(50_000_000);
    tx2.moveCall({
      target: `${packageId}::vault::create_vault`,
      typeArguments: [pool.coinTypeA, pool.coinTypeB],
      arguments: [
        tx2.pure.u64(1000n), // 10.0% performance fee
        tx2.pure.address(SUI_CONFIG.feeTreasuryAddress)
      ]
    });

    const res2 = await grpcClient.signAndExecuteTransaction({
      transaction: tx2,
      signer: keypair,
      include: { effects: true, objectTypes: true }
    });
    const ok2 = unwrapTx(res2);
    await grpcClient.waitForTransaction({ digest: ok2.digest });

    for (const [objId, objType] of Object.entries(ok2.objectTypes || {})) {
      if (objType.includes('::vault::Vault<')) vaultId = objId;
      else if (objType.includes('::vault::OperatorCap')) operatorCapId = objId;
      else if (objType.includes('::vault::VaultAdminCap')) adminCapId = objId;
    }
    if (!vaultId || !operatorCapId) throw new Error('Failed to extract Vault/OperatorCap from Mainnet Tx 2');

    upsertEnvVars({
      VAULT_OBJECT_ID: vaultId,
      VAULT_OPERATOR_CAP: operatorCapId,
      VAULT_ADMIN_CAP: adminCapId || ''
    });

    console.log(`   ✅ Production Vault Created! Digest: ${ok2.digest}`);
    console.log(`      Vault ID:      ${vaultId}`);
    console.log(`      OperatorCap:   ${operatorCapId}`);
    console.log(`      VaultAdminCap: ${adminCapId}`);
    console.log(`      🔗 https://suiscan.xyz/mainnet/tx/${ok2.digest}\n`);
    snapAfterDeploy = await cetusService.getVaultSnapshot(vaultId);
  }

  // -----------------------------------------------------------------
  // TX 3: Small Pilot Deposit (1.00 USDC + 1.00 SUI) if Vault empty
  // -----------------------------------------------------------------
  const depositUsdcRaw = 1_000_000n;     // 1.00 Native USDC
  const depositSuiRaw = 1_000_000_000n;  // 1.00 SUI (~$0.80)
  if (snapAfterDeploy.totalShares === 0n) {
    console.log('🚀 [Tx 3] Depositing 1.00 USDC + 1.00 SUI pilot test allocation...');
    const tx3 = new Transaction();
    tx3.setSender(sender);
    tx3.setGasBudget(50_000_000);
    const coinA = tx3.coin({ type: pool.coinTypeA, balance: depositUsdcRaw });
    const coinB = tx3.coin({ type: pool.coinTypeB, balance: depositSuiRaw });
    const [vaultShare] = tx3.moveCall({
      target: `${packageId}::vault::deposit`,
      typeArguments: [pool.coinTypeA, pool.coinTypeB],
      arguments: [tx3.object(vaultId), coinA, coinB]
    });
    tx3.transferObjects([vaultShare], sender);

    const res3 = await grpcClient.signAndExecuteTransaction({
      transaction: tx3,
      signer: keypair,
      include: { effects: true, objectTypes: true }
    });
    const ok3 = unwrapTx(res3);
    await grpcClient.waitForTransaction({ digest: ok3.digest });
    console.log(`   ✅ Deposited 1.00 USDC + 1.00 SUI! Digest: ${ok3.digest}`);
    console.log(`      🔗 https://suiscan.xyz/mainnet/tx/${ok3.digest}\n`);
  }

  // -----------------------------------------------------------------
  // TX 4: Deploy Initial Concentrated Cetus v15 Position (±10% band) if none
  // -----------------------------------------------------------------
  if (!snapAfterDeploy.positionNftId) {
    const initialBand = computeTargetTickRange(
      pool.currentPrice,
      10,
      pool.tickSpacing,
      pool.decimalsA,
      pool.decimalsB,
      pool.isCoinASui
    );
    const safeUsdc = 950_000n;
    const safeSui = 950_000_000n;
    const probeFixA = ClmmPoolUtil.estLiquidityAndcoinAmountFromOneAmounts(
      initialBand.lowerTick,
      initialBand.upperTick,
      new BN(safeUsdc.toString()),
      true,
      true,
      0,
      new BN(pool.sqrtPriceX64)
    );
    const isFixATx4 = BigInt(probeFixA.coinAmountB.toString()) <= safeSui;
    const fixAmountTx4 = isFixATx4 ? safeUsdc : safeSui;

    console.log(`🚀 [Tx 4] Deploying Initial Mainnet Cetus v15 Position [${initialBand.lowerTick}, ${initialBand.upperTick}]...`);
    const deployPtb = await ptbBuilder.buildDeployInitialPositionPtb({
      vaultId,
      vaultPackageId: packageId,
      operatorCapId,
      poolId,
      coinTypeA: pool.coinTypeA,
      coinTypeB: pool.coinTypeB,
      ownerAddress: sender,
      newLowerTick: initialBand.lowerTick,
      newUpperTick: initialBand.upperTick,
      fixAmount: fixAmountTx4,
      isFixA: isFixATx4
    });

    const exec4 = await ptbBuilder.execute({ ptbResult: deployPtb, signer, forceLive: true });
    snapAfterDeploy = await cetusService.getVaultSnapshot(vaultId);

    console.log(`   ✅ Initial Mainnet Cetus Position Locked in Vault DOF! Digest: ${exec4.digest}`);
    console.log(`      Cetus Position NFT: ${snapAfterDeploy.positionNftId}`);
    console.log(`      Active Ticks:       [${snapAfterDeploy.currentLowerTick}, ${snapAfterDeploy.currentUpperTick}]`);
    console.log(`      LP Hold A/B (raw):  ${snapAfterDeploy.positionAmounts.amountA} uUSDC, ${snapAfterDeploy.positionAmounts.amountB} MIST`);
    console.log(`      🔗 https://suiscan.xyz/mainnet/tx/${exec4.digest}\n`);
  }

  // -----------------------------------------------------------------
  // TX 5: Live Mainnet 7-Step Atomic Rebalance PTB (±8% band + flash_swap + collect_reward)
  // -----------------------------------------------------------------
  const freshPool = await cetusService.getPool(poolId);
  const rebalanceBand = computeTargetTickRange(
    freshPool.currentPrice,
    8,
    freshPool.tickSpacing,
    freshPool.decimalsA,
    freshPool.decimalsB,
    freshPool.isCoinASui
  );
  const rebalanceSwapPlan = computeCetusFlashSwapAndAddPlan({
    rawCoinA: snapAfterDeploy.totalRawA,
    rawCoinB: snapAfterDeploy.totalRawB,
    poolSqrtPriceX64: freshPool.sqrtPriceX64,
    poolLiquidity: freshPool.liquidity,
    lowerTick: rebalanceBand.lowerTick,
    upperTick: rebalanceBand.upperTick,
    feeRateBps: freshPool.feeRate,
    safetyBufferPct: 1.5
  });

  console.log(`🚀 [Tx 5] Executing Live Mainnet 7-Step Atomic Rebalance to ±8% [${rebalanceBand.lowerTick}, ${rebalanceBand.upperTick}]...`);
  console.log(`   flash_swap: ${rebalanceSwapPlan.executeOnChain} (a2b=${rebalanceSwapPlan.a2b}, raw=${rebalanceSwapPlan.swapAmountRaw}), isFixA=${rebalanceSwapPlan.isFixA}, fixAmt=${rebalanceSwapPlan.redeployFixAmount}`);
  console.log(`   rewarders:  ${(freshPool.rewarders || []).join(', ') || 'none'}`);

  const rebalancePtb = await ptbBuilder.buildAtomicRebalancePtb({
    poolId,
    positionNftId: snapAfterDeploy.positionNftId,
    ownerAddress: sender,
    currentTick: freshPool.currentTick,
    newLowerTick: rebalanceBand.lowerTick,
    newUpperTick: rebalanceBand.upperTick,
    swapPlan: rebalanceSwapPlan,
    vaultId,
    vaultPackageId: packageId,
    operatorCapId,
    coinTypeA: snapAfterDeploy.coinTypeA,
    coinTypeB: snapAfterDeploy.coinTypeB,
    redeployFixAmount: rebalanceSwapPlan.redeployFixAmount,
    isFixA: rebalanceSwapPlan.isFixA,
    rewardCoins: freshPool.rewarders || [],
    rewarderGlobalVaultId: cetusService.contracts.rewarderGlobalVaultId,
    isLiveRebalance: true
  });

  const exec5 = await ptbBuilder.execute({ ptbResult: rebalancePtb, signer, forceLive: true });
  const snapFinal = await cetusService.getVaultSnapshot(vaultId);

  console.log(`   ✅ LIVE MAINNET ATOMIC REBALANCE SUCCEEDED! Digest: ${exec5.digest}`);
  console.log(`      Burned Old NFT:     ${snapAfterDeploy.positionNftId}`);
  console.log(`      New Active NFT:     ${snapFinal.positionNftId}`);
  console.log(`      Updated Ticks:      [${snapFinal.currentLowerTick}, ${snapFinal.currentUpperTick}]`);
  console.log(`      LP Hold A/B (raw):  ${snapFinal.positionAmounts.amountA} uUSDC (${(Number(snapFinal.positionAmounts.amountA) / 1e6).toFixed(4)} USDC), ${snapFinal.positionAmounts.amountB} MIST (${(Number(snapFinal.positionAmounts.amountB) / 1e9).toFixed(4)} SUI)`);
  console.log(`      Idle Vault A/B:     ${snapFinal.idleA} uUSDC, ${snapFinal.idleB} MIST`);
  console.log(`      Rebalance Lock:     ${snapFinal.isRebalancing}`);
  console.log(`      🔗 https://suiscan.xyz/mainnet/tx/${exec5.digest}\n`);

  console.log('=================================================================');
  console.log('🎉 MAINNET PILOT DEPLOYED & VERIFIED LIVE END-TO-END!');
  console.log('=================================================================');
}

main().catch((err) => {
  console.error('\n❌ Mainnet pilot failed:', err);
  process.exit(1);
});
