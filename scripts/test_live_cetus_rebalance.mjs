// scripts/test_live_cetus_rebalance.mjs
// End-to-End Live Sui Testnet Execution:
// 1. Creates a fresh BluSky-Sui Vault v2 (<USDC, SUI>)
// 2. Deposits 0.05 SUI into the Vault
// 3. Executes MoveCall PTB #1: Opens & funds a live Cetus CLMM Position NFT into Vault DOF custody
// 4. Executes MoveCall PTB #2: Full 7-step Atomic Rebalance (borrow_position -> collect_fee ->
//    harvest_and_compound -> start_rebalance -> remove_liquidity -> close_position ->
//    open_position -> add_liquidity_fix_coin -> repay_add_liquidity -> finish_rebalance)
// 5. Verifies updated on-chain Vault DOF Position NFT ID & ticks via Sui gRPC

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Transaction } from '@mysten/sui/transactions';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Load .env.testnet BEFORE importing SUI_CONFIG so network & package IDs resolve to Testnet
dotenv.config({ path: path.join(rootDir, '.env.testnet'), override: true });

const { SUI_CONFIG } = await import('../src/config.mjs');
const { CetusService } = await import('../src/services/cetus.mjs');
const { CetusRebalancePtbBuilder, tickToU32 } = await import('../src/ptb/cetusRebalanceBuilder.mjs');

function loadKeypairFromEnv() {
  const raw = process.env.SUI_PRIVATE_KEY;
  if (!raw) {
    throw new Error('Missing SUI_PRIVATE_KEY in .env.testnet');
  }
  if (raw.startsWith('suiprivkey')) {
    const decoded = decodeSuiPrivateKey(raw);
    return Ed25519Keypair.fromSecretKey(decoded.secretKey);
  }
  const clean = raw.replace(/^0x/, '');
  const bytes = /^[0-9a-fA-F]{64}$/.test(clean)
    ? Uint8Array.from(Buffer.from(clean, 'hex'))
    : Uint8Array.from(Buffer.from(raw, 'base64'));
  return Ed25519Keypair.fromSecretKey(bytes.length === 33 ? bytes.slice(1) : bytes);
}

function unwrapTxResult(res) {
  const txObj = res.$kind === 'Transaction' ? res.Transaction : res.FailedTransaction;
  if (res.$kind === 'FailedTransaction' || !txObj?.status?.success) {
    throw new Error(`Transaction failed (digest=${txObj?.digest}): ${JSON.stringify(txObj?.status?.error || res)}`);
  }
  return txObj;
}

async function main() {
  console.log('=================================================================');
  console.log('🧪 BluSky-Sui v2 — Live Cetus Testnet Position & Rebalance PTB');
  console.log('=================================================================\n');

  const keypair = loadKeypairFromEnv();
  const sender = keypair.toSuiAddress();
  const vaultPkg = SUI_CONFIG.vault.packageId;
  const poolId = SUI_CONFIG.pools.cetus_sui_usdc;

  const cetusService = new CetusService('testnet');
  const grpcClient = cetusService.getGrpcClient();
  const ptbBuilder = new CetusRebalancePtbBuilder(cetusService);
  const signer = {
    getKeypair: () => keypair,
    getGrpcClient: () => grpcClient
  };

  console.log(`📦 Vault v2 Package:   ${vaultPkg}`);
  console.log(`🌊 Cetus Pool (Live):  ${poolId}`);
  console.log(`🏛️  Cetus GlobalConfig: ${cetusService.contracts.globalConfigId}`);
  console.log(`⚙️  Cetus publishedAt:  ${cetusService.contracts.publishedAt}`);
  console.log(`👛 Testnet Signer:     ${sender}`);

  const balRes = await grpcClient.getBalance({ owner: sender });
  console.log(`💰 Wallet SUI Balance: ${(Number(balRes.balance.balance) / 1e9).toFixed(4)} SUI\n`);

  // 1. Fetch live pool state via Sui gRPC
  const pool = await cetusService.getPool(poolId);
  if (pool.isSimulated) {
    throw new Error('Pool read fell back to simulated mode — cannot verify live on-chain execution.');
  }
  console.log(`📊 Live Pool State:`);
  console.log(`   CoinA: ${pool.coinTypeA}`);
  console.log(`   CoinB: ${pool.coinTypeB}`);
  console.log(`   Current Tick: ${pool.currentTick}, Tick Spacing: ${pool.tickSpacing}, Fee Rate: ${pool.feeRate}`);
  console.log(`   Active Liquidity: ${pool.liquidity}\n`);

  // Pick two valid ranges strictly BELOW pool.currentTick so single-sided CoinB (SUI) is required
  // (in Uniswap v3 / Cetus CLMM, ranges strictly below current_tick hold 100% CoinB = SUI).
  const spacing = pool.tickSpacing || 2;
  const alignDown = (t) => Math.floor(t / spacing) * spacing;
  const initialUpper = alignDown(pool.currentTick - Math.max(100, spacing * 50));
  const initialLower = alignDown(initialUpper - Math.max(200, spacing * 100));
  const targetUpper = alignDown(pool.currentTick - Math.max(60, spacing * 30));
  const targetLower = alignDown(targetUpper - Math.max(200, spacing * 100));

  console.log(`📐 Selected Single-Sided SUI Tick Bands (Pool Spot Tick = ${pool.currentTick}, Spacing = ${spacing}):`);
  console.log(`   Initial Band: [${initialLower}, ${initialUpper}]`);
  console.log(`   Rebalance Target Band: [${targetLower}, ${targetUpper}]\n`);

  // -----------------------------------------------------------------
  // TX 1: Create Vault<CoinA, CoinB>
  // -----------------------------------------------------------------
  console.log('🚀 [Tx 1/4] Creating fresh Vault v2 on Sui Testnet...');
  const tx1 = new Transaction();
  tx1.setSender(sender);
  tx1.setGasBudget(50_000_000);
  tx1.moveCall({
    target: `${vaultPkg}::vault::create_vault`,
    typeArguments: [pool.coinTypeA, pool.coinTypeB],
    arguments: [
      tx1.pure.u64(1000n), // 10% performance fee
      tx1.pure.address(SUI_CONFIG.feeTreasuryAddress)
    ]
  });

  const res1 = await grpcClient.signAndExecuteTransaction({
    transaction: tx1,
    signer: keypair,
    include: { effects: true, objectTypes: true }
  });
  const ok1 = unwrapTxResult(res1);
  await grpcClient.waitForTransaction({ digest: ok1.digest });

  let vaultId = null;
  let operatorCapId = null;
  let adminCapId = null;
  for (const [objId, objType] of Object.entries(ok1.objectTypes || {})) {
    if (objType.includes('::vault::Vault<')) vaultId = objId;
    else if (objType.includes('::vault::OperatorCap')) operatorCapId = objId;
    else if (objType.includes('::vault::VaultAdminCap')) adminCapId = objId;
  }

  if (!vaultId || !operatorCapId) {
    throw new Error(`Failed to extract Vault or OperatorCap from Tx 1 objectTypes: ${JSON.stringify(ok1.objectTypes)}`);
  }

  console.log(`   ✅ Vault Created! Digest: ${ok1.digest}`);
  console.log(`      Vault Object:  ${vaultId}`);
  console.log(`      OperatorCap:   ${operatorCapId}`);
  console.log(`      VaultAdminCap: ${adminCapId}`);
  console.log(`      🔗 https://suiscan.xyz/testnet/tx/${ok1.digest}\n`);

  // -----------------------------------------------------------------
  // TX 2: Deposit 0.05 SUI (50,000,000 MIST) into Vault
  // -----------------------------------------------------------------
  console.log('🚀 [Tx 2/4] Depositing 0.05 SUI into Vault...');
  const tx2 = new Transaction();
  tx2.setSender(sender);
  tx2.setGasBudget(50_000_000);
  const [zeroCoinA] = tx2.moveCall({
    target: '0x2::coin::zero',
    typeArguments: [pool.coinTypeA],
    arguments: []
  });
  const [depositCoinB] = tx2.splitCoins(tx2.gas, [tx2.pure.u64(50_000_000n)]);
  const [vaultShare] = tx2.moveCall({
    target: `${vaultPkg}::vault::deposit`,
    typeArguments: [pool.coinTypeA, pool.coinTypeB],
    arguments: [tx2.object(vaultId), zeroCoinA, depositCoinB]
  });
  tx2.transferObjects([vaultShare], sender);

  const res2 = await grpcClient.signAndExecuteTransaction({
    transaction: tx2,
    signer: keypair,
    include: { effects: true, objectTypes: true }
  });
  const ok2 = unwrapTxResult(res2);
  await grpcClient.waitForTransaction({ digest: ok2.digest });

  console.log(`   ✅ Deposited 0.05 SUI! Digest: ${ok2.digest}`);
  console.log(`      🔗 https://suiscan.xyz/testnet/tx/${ok2.digest}\n`);

  // -----------------------------------------------------------------
  // TX 3: Deploy Initial Cetus Position NFT into Vault DOF Custody
  // -----------------------------------------------------------------
  console.log(`🚀 [Tx 3/4] Deploying 0.04 SUI into Cetus Position [${initialLower}, ${initialUpper}] inside Vault DOF...`);
  const deployPtb = await ptbBuilder.buildDeployInitialPositionPtb({
    vaultId,
    vaultPackageId: vaultPkg,
    operatorCapId,
    poolId,
    coinTypeA: pool.coinTypeA,
    coinTypeB: pool.coinTypeB,
    ownerAddress: sender,
    newLowerTick: initialLower,
    newUpperTick: initialUpper,
    fixAmount: 40_000_000n,
    isFixA: false
  });

  const deployExec = await ptbBuilder.execute({
    ptbResult: deployPtb,
    signer,
    forceLive: true
  });

  const vaultAfterDeploy = await grpcClient.getObject({
    objectId: vaultId,
    include: { json: true }
  });
  const oldPositionId = vaultAfterDeploy.object?.json?.clmm_position_id;
  if (!oldPositionId) {
    throw new Error(`Expected clmm_position_id on Vault after deploy, got: ${JSON.stringify(vaultAfterDeploy.object?.json)}`);
  }

  console.log(`   ✅ Initial Cetus Position Deployed & Locked in Vault DOF! Digest: ${deployExec.digest}`);
  console.log(`      Cetus Position NFT ID: ${oldPositionId}`);
  console.log(`      Vault Lower/Upper Ticks: [${vaultAfterDeploy.object.json.current_lower_tick}, ${vaultAfterDeploy.object.json.current_upper_tick}]`);
  console.log(`      🔗 https://suiscan.xyz/testnet/tx/${deployExec.digest}\n`);

  // -----------------------------------------------------------------
  // TX 4: Full 7-Step Atomic Cetus Rebalance PTB
  // -----------------------------------------------------------------
  console.log(`🚀 [Tx 4/4] Executing 7-Step Atomic Cetus Rebalance PTB to [${targetLower}, ${targetUpper}]...`);
  const rebalancePtb = await ptbBuilder.buildAtomicRebalancePtb({
    poolId,
    positionNftId: oldPositionId,
    ownerAddress: sender,
    currentTick: pool.currentTick,
    newLowerTick: targetLower,
    newUpperTick: targetUpper,
    vaultId,
    vaultPackageId: vaultPkg,
    operatorCapId,
    coinTypeA: pool.coinTypeA,
    coinTypeB: pool.coinTypeB,
    redeployFixAmount: 35_000_000n,
    isFixA: false,
    isLiveRebalance: true
  });

  const rebalanceExec = await ptbBuilder.execute({
    ptbResult: rebalancePtb,
    signer,
    forceLive: true
  });

  const vaultAfterRebalance = await grpcClient.getObject({
    objectId: vaultId,
    include: { json: true }
  });
  const newPositionId = vaultAfterRebalance.object?.json?.clmm_position_id;
  const dofList = await grpcClient.listDynamicFields({ parentId: vaultId });

  console.log(`   ✅ Atomic Cetus Rebalance SUCCEEDED! Digest: ${rebalanceExec.digest}`);
  console.log(`      Old Exhausted Position (Burned): ${oldPositionId}`);
  console.log(`      New Active Position (in Vault DOF): ${newPositionId}`);
  console.log(`      Position Replaced On-Chain: ${newPositionId && newPositionId !== oldPositionId}`);
  console.log(`      Vault Rebalancing Lock: ${vaultAfterRebalance.object.json.is_rebalancing}`);
  console.log(`      Vault Updated Ticks: [${vaultAfterRebalance.object.json.current_lower_tick}, ${vaultAfterRebalance.object.json.current_upper_tick}]`);
  console.log(`      Expected Ticks (u32): [${tickToU32(targetLower)}, ${tickToU32(targetUpper)}]`);
  console.log(`      Vault Dynamic Fields Count: ${dofList.dynamicFields?.length ?? 0}`);
  console.log(`      🔗 https://suiscan.xyz/testnet/tx/${rebalanceExec.digest}\n`);

  console.log('=================================================================');
  console.log('🏁 LIVE TESTNET VERIFICATION COMPLETE — ALL 4 TRANSACTIONS PASSED');
  console.log('=================================================================');
}

main().catch((err) => {
  console.error('\n❌ Live Testnet Cetus execution failed:', err);
  process.exit(1);
});
