// src/server.mjs
// BluSky-Sui Web Dashboard Server & REST API

// Catch any unhandled promise rejections or background RPC socket drops
process.on('unhandledRejection', () => {});
process.on('uncaughtException', (err) => {
  if (err.message?.includes('fetch failed') || err.message?.includes('INVALID_ARGUMENT')) return;
  console.warn('[Server Warning]', err.message);
});

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fromBase64, toBase64 } from '@mysten/sui/utils';
import { SUI_CONFIG, getVaultCatalog, resolveVaultConfig } from './config.mjs';
import { VaultApiService } from './dashboard/vaultApi.mjs';
import { listAllOwnedVaultShares } from './services/vaultContract.mjs';
import { TurbosService, fetchLiveSuiPrice } from './services/turbos.mjs';
import { defaultCetusService } from './services/cetus.mjs';
import { CetusRebalancePtbBuilder } from './ptb/cetusRebalanceBuilder.mjs';
import { TurbosRebalancePtbBuilder } from './ptb/rebalanceBuilder.mjs';
import { WalletManager } from './services/wallet.mjs';
import { HedgingEngine } from './hedging/hedgingEngine.mjs';
import { computeTargetTickRange, evaluateEconomicViability } from './strategy/rebalanceMath.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MONITOR_STATUS_PATH = path.join(__dirname, '..', '.monitor-status.json');

const PORT = process.env.PORT || 3000;

// State management for interactive demo
let currentScenario = 'normal'; // 'normal', 'drift', 'hedge'

const vaultApi = new VaultApiService();
const turbosService = new TurbosService();
const hedgingEngine = new HedgingEngine({ turbosService });
const operatorWallet = new WalletManager();
const operatorAddress = operatorWallet.isConfigured() ? operatorWallet.getAddress() : null;
const ptbBuilder = new CetusRebalancePtbBuilder(defaultCetusService);
const turbosPtbBuilder = new TurbosRebalancePtbBuilder(turbosService);
const pendingPreparedTxs = new Map();
const PREPARED_TX_TTL_MS = 5 * 60 * 1000;
const statusCache = new Map();
const statusInflight = new Map();
const STATUS_FRESH_TTL_MS = 12_000;
const STATUS_STALE_TTL_MS = 90_000;

function getVaultRuntime(vaultKeyOrId = null) {
  const vaultConfig = resolveVaultConfig(vaultKeyOrId);
  const isTurbos = vaultConfig.dex === 'turbos';
  return {
    vaultConfig,
    dexService: isTurbos ? turbosService : defaultCetusService,
    builder: isTurbos ? turbosPtbBuilder : ptbBuilder
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error('Request payload too large'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function hashBytesBase64(bytesBase64) {
  return crypto.createHash('sha256').update(String(bytesBase64 || '')).digest('hex');
}

function storePreparedTx(entry) {
  const now = Date.now();
  for (const [k, v] of pendingPreparedTxs.entries()) {
    if (now - v.createdAt > PREPARED_TX_TTL_MS) pendingPreparedTxs.delete(k);
  }
  const key = hashBytesBase64(entry.bytesBase64);
  pendingPreparedTxs.set(key, { ...entry, createdAt: now });
  return key;
}

async function getUserVaultShareObjects(userAddress, vaultSnapshot) {
  const grpcClient = defaultCetusService.grpcClient;
  if (!grpcClient || !vaultSnapshot) return [];
  const shareType = `${SUI_CONFIG.vault.packageId}::vault::VaultShare<${vaultSnapshot.coinTypeA}, ${vaultSnapshot.coinTypeB}>`;
  return listAllOwnedVaultShares(grpcClient, userAddress, vaultSnapshot.vaultId, shareType);
}

function clampGasPriorityMultiplier(value, fallback = 5) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.max(1, Math.min(50, Math.round(num)));
}

async function prepareLivePtbResponse({ ptbResult, action, userAddress, gasPriorityMultiplier = 5 }) {
  const priorityMultiplier = clampGasPriorityMultiplier(gasPriorityMultiplier, 5);
  let baseRefPrice = 100n;
  try {
    const rgp = await defaultCetusService.grpcClient.getReferenceGasPrice();
    const parsed = BigInt(rgp?.referenceGasPrice || 100);
    if (parsed > 0n) baseRefPrice = parsed;
  } catch {}
  const uncappedGasPrice = baseRefPrice * BigInt(priorityMultiplier);
  const targetGasPrice = uncappedGasPrice > 50000n ? 50000n : uncappedGasPrice;
  ptbResult.tx.setGasPrice(targetGasPrice);

  const txBytes = await ptbResult.tx.build({ client: defaultCetusService.grpcClient });
  const bytesBase64 = toBase64(txBytes);
  const txJson = await ptbResult.tx.toJSON();

  const simRes = await defaultCetusService.grpcClient.simulateTransaction({
    transaction: txBytes,
    include: { effects: true, balanceChanges: true }
  });
  const simTx = simRes.$kind === 'Transaction' ? simRes.Transaction : simRes.FailedTransaction;
  if (simRes.$kind === 'FailedTransaction' || !simTx?.status?.success) {
    throw new Error(`Dry-run simulation failed: ${JSON.stringify(simTx?.status?.error || simRes)}`);
  }

  const gasUsed = simTx?.effects?.gasUsed;
  const netGasMist =
    Number(gasUsed?.computationCost || 0) +
    Number(gasUsed?.storageCost || 0) -
    Number(gasUsed?.storageRebate || 0);
  const summary = {
    ...ptbResult.summary,
    estGasSui: Math.max(0, netGasMist) / 1e9,
    gasPriceMist: targetGasPrice.toString(),
    referenceGasPriceMist: baseRefPrice.toString(),
    gasPriorityMultiplier: priorityMultiplier,
    requiresOperatorCosign: Boolean(ptbResult?.requiresOperatorCosign)
  };

  storePreparedTx({ action, userAddress, bytesBase64, summary });
  return { success: true, txJson, bytesBase64, summary, steps: ptbResult.steps };
}

async function executeSignedLivePtb({ bytesBase64, signature, userAddress, expectedAction }) {
  if (!bytesBase64 || !signature || !userAddress) {
    throw new Error('Missing signed transaction bytes, signature, or userAddress');
  }
  const grpcClient = defaultCetusService.grpcClient;
  if (!grpcClient) throw new Error('Sui gRPC client unavailable');

  const key = hashBytesBase64(bytesBase64);
  const pending = pendingPreparedTxs.get(key);
  const txBytes = fromBase64(bytesBase64);
  const signatures = [signature];

  if (pending?.summary?.requiresOperatorCosign) {
    if (pending.action !== expectedAction || pending.userAddress.toLowerCase() !== userAddress.toLowerCase()) {
      throw new Error('Transaction mismatch or expired preparation; please re-prepare before signing');
    }
    if (!operatorWallet.isConfigured()) {
      throw new Error('Operator keypair is not configured on backend for co-signing');
    }
    const opSigned = await operatorWallet.getKeypair().signTransaction(txBytes);
    signatures.push(opSigned.signature);
  }

  pendingPreparedTxs.delete(key);

  const execRes = await grpcClient.executeTransaction({
    transaction: txBytes,
    signatures,
    include: { effects: true, events: true, balanceChanges: true }
  });
  const txRecord = execRes.$kind === 'Transaction' ? execRes.Transaction : execRes.FailedTransaction;
  const digest = txRecord?.digest;
  if (digest) {
    await grpcClient.waitForTransaction({ digest });
  }
  if (execRes.$kind === 'FailedTransaction' || !txRecord?.status?.success) {
    const rawErr = txRecord?.status?.error || execRes;
    const congestedList = rawErr?.CongestedObjects?.objects || [];
    const errDetail = JSON.stringify(rawErr);
    if (rawErr?.$kind === 'CongestedObjects' || errDetail.includes('SharedObjectCongestion')) {
      const objPreview = congestedList.length > 0 ? congestedList.map((id) => `${id.slice(0, 10)}...${id.slice(-6)}`).join(', ') : 'shared DEX pool';
      const err = new Error(`Shared pool object temporarily congested (${objPreview}). No VaultShares or funds were spent — please retry with higher priority gas.`);
      err.code = 'SHARED_OBJECT_CONGESTION';
      err.digest = digest || null;
      err.congestedObjects = congestedList;
      throw err;
    }
    const err = new Error(`On-chain transaction failed${digest ? ` (${digest})` : ''}: ${errDetail}`);
    err.digest = digest || null;
    throw err;
  }

  return {
    digest,
    events: (txRecord.events || []).map((e) => ({ type: e.eventType, json: e.json })),
    balanceChanges: txRecord.balanceChanges || [],
    summary: pending?.summary || null
  };
}

function readMonitorStatus() {
  try {
    if (!fs.existsSync(MONITOR_STATUS_PATH)) return null;
    const raw = fs.readFileSync(MONITOR_STATUS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const ageMs = parsed?.updatedAt ? (Date.now() - new Date(parsed.updatedAt).getTime()) : Infinity;
    return {
      ...parsed,
      ageSec: Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 1000)) : null,
      isActive: Number.isFinite(ageMs) && ageMs < 120000
    };
  } catch {
    return null;
  }
}

function buildLiveRecentEvents(vaultSnapshot, monitorStatus, currentPrice) {
  const events = [];
  if (Array.isArray(monitorStatus?.recentEvents)) {
    events.push(...monitorStatus.recentEvents);
  }
  if (vaultSnapshot) {
    events.push({
      id: `live_vault_${vaultSnapshot.positionNftId || vaultSnapshot.vaultId}`,
      type: 'VAULT_LIVE',
      vaultId: vaultSnapshot.vaultId,
      positionNftId: vaultSnapshot.positionNftId,
      lowerTick: vaultSnapshot.position?.lowerTick ?? vaultSnapshot.currentLowerTick,
      upperTick: vaultSnapshot.position?.upperTick ?? vaultSnapshot.currentUpperTick,
      totalUsdc: vaultSnapshot.totalUsdc,
      totalSui: vaultSnapshot.totalSui,
      tvlUsd: Math.round((vaultSnapshot.totalUsdc + vaultSnapshot.totalSui * currentPrice) * 100) / 100,
      timestamp: monitorStatus?.updatedAt || new Date().toISOString()
    });
  }
  return events.length > 0 ? events : null;
}

let immediateHedgeSyncInflight = null;

async function triggerImmediateHedgeSync(reason = 'vault_tx') {
  if (SUI_CONFIG.executionMode !== 'LIVE' || !SUI_CONFIG.hedging.enabled) {
    return null;
  }
  if (immediateHedgeSyncInflight) {
    return immediateHedgeSyncInflight;
  }
  immediateHedgeSyncInflight = (async () => {
    try {
      const catalog = getVaultCatalog();
      const entries = [];
      for (const vCfg of Object.values(catalog)) {
        if (!vCfg?.objectId) continue;
        const dexService = vCfg.dex === 'turbos' ? turbosService : defaultCetusService;
        const snap = await dexService.getVaultSnapshot(vCfg.objectId).catch(() => null);
        if (!snap?.positionNftId || !snap?.pool) continue;
        const analysis = await dexService.analyzePosition(
          snap.pool.objectId,
          snap.position.lowerTick,
          snap.position.upperTick,
          snap.positionNftId
        ).catch(() => null);
        if (analysis) {
          entries.push({ vaultCfg: vCfg, liveVaultSnapshot: snap, analysis });
        }
      }
      if (entries.length === 0) return null;

      const report = await hedgingEngine.evaluateMultiVaultHedge(entries, null, {
        executeOrders: true,
        minOrderSizeSui: 1.0
      });

      const existing = readMonitorStatus();
      if (existing) {
        const updated = {
          ...existing,
          updatedAt: new Date().toISOString(),
          hedging: {
            ...(existing.hedging || {}),
            timestamp: report.timestamp,
            spotDeltaSui: report.spotMetrics?.spotDeltaSui,
            spotDeltaUsd: report.spotMetrics?.spotDeltaUsd,
            perpShortSizeSui: report.perpStatus?.shortSizeSui,
            perpShortNotionalUsd: report.perpStatus?.notionalUsd,
            netDeltaSui: report.deltaStatus?.netDeltaSui,
            netDeltaUsd: report.deltaStatus?.netDeltaUsd,
            deltaDriftPct: report.deltaStatus?.deltaDriftPct,
            adjustmentAction: report.deltaStatus?.adjustmentAction,
            adjustmentResult: report.adjustmentResult,
            hedgeCapacity: report.hedgeCapacity || null,
            marginAvailableUsd: report.perpStatus?.marginAvailableUsd,
            totalAccountValueUsd: report.perpStatus?.totalAccountValueUsd,
            vaultBreakdown: report.vaultBreakdown
          }
        };
        const tmpPath = `${MONITOR_STATUS_PATH}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2));
        fs.renameSync(tmpPath, MONITOR_STATUS_PATH);
      }
      statusCache.clear();
      if (report?.adjustmentResult) {
        console.log(`⚡ [Immediate Hedge Sync (${reason})] ${report.adjustmentResult.description}`);
      } else {
        console.log(`🛡️ [Immediate Hedge Sync (${reason})] Δ=${report?.deltaStatus?.netDeltaSui?.toFixed(2)} SUI (${report?.deltaStatus?.deltaDriftPct?.toFixed(2)}% drift)`);
      }
      return report;
    } catch (err) {
      console.warn(`⚠️ [Immediate Hedge Sync (${reason})] skipped:`, err.message);
      return null;
    } finally {
      immediateHedgeSyncInflight = null;
    }
  })();
  return immediateHedgeSyncInflight;
}

function resolveScenarioPrice(livePrice, scenario) {
  if (scenario === 'drift') {
    return Math.round(livePrice * 0.85 * 10000) / 10000; // -15% drop -> breaches active band!
  }
  if (scenario === 'hedge') {
    return Math.round(livePrice * 0.94 * 10000) / 10000; // -6% drop -> in-range, triggers Perp delta re-hedge
  }
  return livePrice;
}

async function getLiveState(userAddress = null, vaultKey = null, bypassCache = false) {
  const { vaultConfig, dexService } = getVaultRuntime(vaultKey);
  const cacheKey = `${vaultConfig.key}:${String(userAddress || '').toLowerCase()}:${currentScenario}`;
  const cached = !bypassCache ? statusCache.get(cacheKey) : null;
  const ageMs = cached ? (Date.now() - cached.ts) : Infinity;

  if (cached && ageMs < STATUS_FRESH_TTL_MS) {
    return cached.data;
  }

  const startRefresh = () => {
    if (statusInflight.has(cacheKey)) {
      return statusInflight.get(cacheKey);
    }
    const p = (async () => {
  const vaultId = vaultConfig.objectId;
  const vaultSnapshot = (vaultId && /^0x[0-9a-fA-F]{32,64}$/.test(vaultId))
    ? await dexService.getVaultSnapshot(vaultId).catch(() => null)
    : null;

  const livePrice = vaultSnapshot?.pool?.currentPrice || await fetchLiveSuiPrice();
  const simPrice = resolveScenarioPrice(livePrice, currentScenario);

  const isCoinASui = Boolean(vaultConfig.isCoinASui);
  const fallbackBand = computeTargetTickRange(
    livePrice,
    SUI_CONFIG.strategy.targetBandWidthPct || 10,
    vaultConfig.tickSpacing || 10,
    isCoinASui ? SUI_CONFIG.decimals.SUI : SUI_CONFIG.decimals.USDC,
    isCoinASui ? SUI_CONFIG.decimals.USDC : SUI_CONFIG.decimals.SUI,
    isCoinASui
  );

  const targetPoolId = vaultSnapshot?.pool?.objectId || vaultConfig.poolId;
  const posLowerTick = vaultSnapshot?.position?.lowerTick ?? fallbackBand.lowerTick;
  const posUpperTick = vaultSnapshot?.position?.upperTick ?? fallbackBand.upperTick;
  const posNftId = vaultSnapshot?.positionNftId || `0x_${vaultConfig.dex}_active_vault_position`;
  const hasLivePos = Boolean(vaultSnapshot?.positionNftId && currentScenario === 'normal');

  // 1. Run CLMM analysis (reusing preloaded pool/position), accrued fees, and user share lookup in parallel
  const [clmmAnalysis, liveFees, userPosition] = await Promise.all([
    dexService.analyzePosition(
      targetPoolId,
      posLowerTick,
      posUpperTick,
      posNftId,
      simPrice,
      { pool: vaultSnapshot?.pool || null, position: vaultSnapshot?.position || null, skipFees: hasLivePos }
    ),
    (hasLivePos && vaultSnapshot?.pool)
      ? dexService.getVaultAccruedFees(
          vaultSnapshot.vaultId,
          vaultSnapshot.pool,
          vaultConfig.callPackageId || vaultConfig.packageId,
          operatorAddress || SUI_CONFIG.feeTreasuryAddress,
          vaultSnapshot.position
        )
      : Promise.resolve(null),
    userAddress ? vaultApi.getUserPosition(userAddress, simPrice, vaultSnapshot) : Promise.resolve(null)
  ]);

  if (hasLivePos) {
    const resolvedFees = liveFees || {
      feeA_Sui: 0,
      feeB_Usdc: 0,
      totalFeesUsd: 0,
      protocolFeeUsd: 0,
      compoundedYieldUsd: 0,
      isSimulated: false
    };
    clmmAnalysis.accruedFees = resolvedFees;
    clmmAnalysis.viability = evaluateEconomicViability(
      resolvedFees.totalFeesUsd,
      0.008,
      SUI_CONFIG.strategy.maxCostToFeeRatio,
      SUI_CONFIG.strategy.minFeesBeforeRebalanceUsd,
      !clmmAnalysis.rangeMetrics.inRange
    );
    clmmAnalysis.shouldRebalance =
      clmmAnalysis.rangeMetrics.isDriftTriggered && clmmAnalysis.viability.isViable;
  }

  const monitorStatus = readMonitorStatus();
  const liveRecentEvents = buildLiveRecentEvents(vaultSnapshot, monitorStatus, simPrice);
  const hedgingActive = SUI_CONFIG.hedging.enabled || currentScenario === 'hedge';

  // 2. Vault Summary (computed using live selected Mainnet vault snapshot)
  const vaultSummary = await vaultApi.getPublicVaultSummary(simPrice, {
    vaultConfig,
    vaultSnapshot,
    ...(vaultConfig.dex === 'turbos' ? { turbosAnalysis: clmmAnalysis } : { cetusAnalysis: clmmAnalysis }),
    recentEvents: liveRecentEvents,
    hedgingEnabled: hedgingActive
  });

  // 3. Hedging Evaluation (real Bluefin Pro telemetry + live/simulated hedge status)
  let hedgingState;
  if (hedgingActive) {
    const isSimulatedScenario = currentScenario === 'hedge';
    const activeEngine = isSimulatedScenario
      ? new HedgingEngine({ turbosService, forceVirtual: true, initialShortSizeSui: Math.max(10, Math.round((vaultSnapshot?.totalSui || 371.729) * 1000) / 1000) })
      : hedgingEngine;
    const hedgeReport = await activeEngine.evaluateAndHedge(clmmAnalysis, simPrice, {
      spotDeltaSui: vaultSnapshot ? vaultSnapshot.totalSui : undefined,
      usdcHeld: vaultSnapshot ? vaultSnapshot.totalUsdc : undefined,
      grossApr: parseFloat(vaultSummary.apy.grossTradingApr) || undefined,
      executeOrders: isSimulatedScenario
    });
    hedgingState = {
      enabled: true,
      mode: isSimulatedScenario ? 'DELTA_NEUTRAL_SIMULATED' : 'DELTA_NEUTRAL',
      market: hedgeReport.perpStatus.market,
      source: hedgeReport.perpStatus.source,
      accountAddress: hedgeReport.perpStatus.accountAddress,
      accountExists: hedgeReport.perpStatus.accountExists,
      accountNeedsDeposit: hedgeReport.perpStatus.accountNeedsDeposit,
      marginAvailableUsd: hedgeReport.perpStatus.marginAvailableUsd,
      totalAccountValueUsd: hedgeReport.perpStatus.totalAccountValueUsd,
      spotDeltaSui: hedgeReport.spotMetrics.spotDeltaSui,
      spotDeltaUsd: hedgeReport.spotMetrics.spotDeltaUsd,
      perpShortSizeSui: hedgeReport.perpStatus.shortSizeSui,
      perpShortNotionalUsd: hedgeReport.perpStatus.notionalUsd,
      netDeltaSui: hedgeReport.deltaStatus.netDeltaSui,
      netDeltaUsd: hedgeReport.deltaStatus.netDeltaUsd,
      deltaDriftPct: hedgeReport.deltaStatus.deltaDriftPct,
      requiresRehedge: hedgeReport.deltaStatus.requiresRehedge,
      adjustmentAction: hedgeReport.deltaStatus.adjustmentAction,
      adjustmentResult: hedgeReport.adjustmentResult,
      fundingRate8hPct: hedgeReport.fundingInfo.rate8hPct,
      annualizedFundingApr: hedgeReport.fundingInfo.annualizedApr,
      fundingSource: hedgeReport.fundingInfo.source,
      liquidationPrice: hedgeReport.perpStatus.marginHealth?.liquidationPrice || 0,
      liquidationBufferPct: hedgeReport.perpStatus.marginHealth?.safetyMarginToLiqPct || 0,
      hedgeCapacity: hedgeReport.hedgeCapacity || null,
      netApy: hedgeReport.apyBreakdown.netMarketNeutralApy
    };
  } else {
    const spotSui = vaultSnapshot ? vaultSnapshot.totalSui : 0;
    const spotUsd = Math.round(spotSui * simPrice * 10000) / 10000;
    const [shadowPerp, shadowFunding] = await Promise.all([
      hedgingEngine.bluefinService.getPerpPosition(simPrice).catch(() => null),
      hedgingEngine.bluefinService.getFundingRate().catch(() => null)
    ]);
    hedgingState = {
      enabled: false,
      mode: 'CLMM_ONLY',
      market: shadowPerp?.market || 'SUI-PERP (Shadow)',
      source: shadowPerp?.source || 'Bluefin Pro API',
      accountAddress: shadowPerp?.accountAddress || operatorAddress,
      accountExists: shadowPerp?.accountExists ?? false,
      accountNeedsDeposit: shadowPerp?.accountNeedsDeposit ?? true,
      marginAvailableUsd: shadowPerp?.marginAvailableUsd ?? 0,
      totalAccountValueUsd: shadowPerp?.totalAccountValueUsd ?? 0,
      spotDeltaSui: spotSui,
      spotDeltaUsd: spotUsd,
      perpShortSizeSui: shadowPerp?.shortSizeSui ?? 0,
      perpShortNotionalUsd: shadowPerp?.notionalUsd ?? 0,
      netDeltaSui: Math.round((spotSui - (shadowPerp?.shortSizeSui ?? 0)) * 10000) / 10000,
      netDeltaUsd: Math.round((spotUsd - (shadowPerp?.notionalUsd ?? 0)) * 10000) / 10000,
      deltaDriftPct: 0,
      requiresRehedge: false,
      adjustmentAction: 'DISABLED',
      adjustmentResult: null,
      fundingRate8hPct: shadowFunding?.rate8hPct ?? 0,
      annualizedFundingApr: shadowFunding?.annualizedApr ?? 0,
      fundingSource: shadowFunding?.source || 'Bluefin Pro API',
      liquidationPrice: shadowPerp?.marginHealth?.liquidationPrice || 0,
      liquidationBufferPct: shadowPerp?.marginHealth?.safetyMarginToLiqPct || 0,
      netApy: parseFloat(vaultSummary.apy.netInvestorApy) || 0
    };
  }

  const targetLower = Math.round(simPrice * (1 - (SUI_CONFIG.strategy.targetBandWidthPct || 10) / 100) * 10000) / 10000;
  const targetUpper = Math.round(simPrice * (1 + (SUI_CONFIG.strategy.targetBandWidthPct || 10) / 100) * 10000) / 10000;

  return {
    scenario: currentScenario,
    executionMode: SUI_CONFIG.executionMode,
    hedgingEnabled: SUI_CONFIG.hedging.enabled,
    operatorAddress,
    liveMarketPrice: livePrice,
    currentPrice: simPrice,
    monitor: monitorStatus,
    clmm: {
      dex: vaultConfig.dexName || clmmAnalysis.dex || 'Cetus Protocol',
      vaultKey: vaultConfig.key,
      feeTier: vaultConfig.feeTier,
      poolId: clmmAnalysis.pool.objectId,
      positionNftId: posNftId,
      lowerTick: posLowerTick,
      upperTick: posUpperTick,
      isRebalancing: Boolean(vaultSnapshot?.isRebalancing),
      price: simPrice,
      lowerPrice: clmmAnalysis.rangeMetrics.priceLower,
      upperPrice: clmmAnalysis.rangeMetrics.priceUpper,
      progressPct: clmmAnalysis.rangeMetrics.progressPct,
      nearestBoundaryPct: clmmAnalysis.rangeMetrics.nearestBoundaryDistancePct,
      inRange: clmmAnalysis.rangeMetrics.inRange,
      isDriftTriggered: clmmAnalysis.rangeMetrics.isDriftTriggered,
      accruedFeesUsd: clmmAnalysis.accruedFees.totalFeesUsd,
      accruedFeesSui: clmmAnalysis.accruedFees.feeA_Sui,
      accruedFeesUsdc: clmmAnalysis.accruedFees.feeB_Usdc,
      isSimulatedFees: Boolean(clmmAnalysis.accruedFees.isSimulated),
      shouldRebalance: clmmAnalysis.shouldRebalance,
      rebalanceAction: clmmAnalysis.shouldRebalance ? 'REBALANCED_SIMULATED' : 'HOLDING',
      targetNewBand: clmmAnalysis.shouldRebalance ? { lower: targetLower, upper: targetUpper } : null,
      volume24hUsd: clmmAnalysis.metrics.volume24hUsd,
      poolLiquidityUsd: clmmAnalysis.metrics.liquidityUsd,
      concentrationMultiplier: clmmAnalysis.metrics.concentrationMultiplier
    },
    hedging: hedgingState,
    vault: vaultSummary,
    vaultAllocation: vaultSnapshot ? (() => {
      const usdcVal = vaultSnapshot.totalUsdc;
      const suiVal = vaultSnapshot.totalSui * simPrice;
      const totVal = usdcVal + suiVal;
      return {
        totalUsdc: usdcVal,
        totalSui: vaultSnapshot.totalSui,
        usdcPct: totVal > 0 ? Math.round((usdcVal / totVal) * 1000) / 10 : 50,
        suiPct: totVal > 0 ? Math.round((suiVal / totVal) * 1000) / 10 : 50,
        totalShares: vaultSnapshot.totalShares.toString()
      };
    })() : null,
    userPosition,
    network: SUI_CONFIG.network,
    isTestnet: SUI_CONFIG.isTestnet,
    timestamp: new Date().toISOString()
  };
    })();
    statusInflight.set(cacheKey, p);
    p.then((data) => {
      statusCache.set(cacheKey, { data, ts: Date.now() });
    }).catch(() => {}).finally(() => {
      statusInflight.delete(cacheKey);
    });
    return p;
  };

  // Stale-while-revalidate: serve immediately (<5ms) if <=90s old and refresh in background
  if (cached && ageMs < STATUS_STALE_TTL_MS) {
    startRefresh();
    return cached.data;
  }

  return startRefresh();
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = reqUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API Endpoints ---

  if (pathname === '/api/status' && req.method === 'GET') {
    const address = reqUrl.searchParams.get('address');
    const vaultKey = reqUrl.searchParams.get('vault') || reqUrl.searchParams.get('vaultId');
    const fresh = reqUrl.searchParams.get('fresh') === '1';
    const data = await getLiveState(address, vaultKey, fresh);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  if (pathname === '/api/suins/resolve' && req.method === 'GET') {
    try {
      const raw = String(reqUrl.searchParams.get('name') || '').trim().toLowerCase();
      if (!raw) {
        sendJson(res, 400, { success: false, error: 'Missing SuiNS name' });
        return;
      }
      const cleaned = raw.startsWith('@') ? `${raw.slice(1)}.sui` : (raw.endsWith('.sui') ? raw : `${raw}.sui`);
      if (!/^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*\.sui$/.test(cleaned)) {
        sendJson(res, 400, { success: false, error: 'Invalid SuiNS name format' });
        return;
      }
      const gqlRes = await fetch(SUI_CONFIG.graphqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'query($domain: String!) { nameRecord(name: $domain) { domain target { address } } }',
          variables: { domain: cleaned }
        })
      });
      const gqlJson = await gqlRes.json();
      const targetAddr = gqlJson?.data?.nameRecord?.target?.address || null;
      if (!targetAddr) {
        sendJson(res, 404, { success: false, error: `SuiNS name ${cleaned} does not resolve to an address` });
        return;
      }
      sendJson(res, 200, {
        success: true,
        domain: gqlJson.data.nameRecord.domain || cleaned,
        handle: `@${cleaned.replace(/\.sui$/, '')}`,
        address: targetAddr
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return;
  }

  if (pathname === '/api/user/position' && req.method === 'GET') {
    const address = reqUrl.searchParams.get('address');
    const vaultKey = reqUrl.searchParams.get('vault') || reqUrl.searchParams.get('vaultId');
    const { vaultConfig, dexService } = getVaultRuntime(vaultKey);
    const snap = vaultConfig.objectId ? await dexService.getVaultSnapshot(vaultConfig.objectId).catch(() => null) : null;
    const simPrice = resolveScenarioPrice(snap?.pool?.currentPrice || await fetchLiveSuiPrice(), currentScenario);
    const position = await vaultApi.getUserPosition(address, simPrice, snap);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, vaultKey: vaultConfig.key, position }));
    return;
  }

  if (pathname === '/api/vault/deposit/prepare' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const userAddress = payload.userAddress || payload.address;
      const amountUsdc = parseFloat(payload.amountUsdc || payload.amount || 0);
      const vaultKey = payload.vault || payload.vaultKey || payload.vaultId;
      const { vaultConfig, dexService, builder } = getVaultRuntime(vaultKey);
      const vaultSnapshot = await dexService.getVaultSnapshot(vaultConfig.objectId);
      if (!vaultSnapshot) throw new Error(`Could not load live state for vault ${vaultConfig.label}`);

      const ptbResult = await builder.buildZapDepositPtb({
        userAddress,
        depositUsdcAmount: amountUsdc,
        vaultSnapshot,
        vaultId: vaultConfig.objectId,
        vaultCallPackageId: vaultConfig.callPackageId,
        operatorCapId: vaultConfig.operatorCap,
        poolId: vaultConfig.poolId
      });
      const response = await prepareLivePtbResponse({
        ptbResult,
        action: 'deposit',
        userAddress,
        gasPriorityMultiplier: payload.gasPriorityMultiplier
      });
      console.log(`🔧 [${vaultConfig.shortLabel} Deposit Prepare] user=${userAddress.slice(0, 8)}... amountUsdc=${amountUsdc} shares=${response.summary.sharesToMint}`);
      sendJson(res, 200, response);
    } catch (err) {
      console.error('❌ [Deposit Prepare Error]', err.message);
      sendJson(res, 400, { success: false, error: err.message });
    }
    return;
  }

  if (pathname === '/api/vault/deposit/execute' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const userAddress = payload.userAddress || payload.address;
      const result = await executeSignedLivePtb({
        bytesBase64: payload.bytes || payload.bytesBase64,
        signature: payload.signature,
        userAddress,
        expectedAction: 'deposit'
      });
      const depEvt = result.events.find((e) => e.type?.includes('::vault::DepositEvent'))?.json;
      const displayAddr = userAddress.length > 10 ? `${userAddress.slice(0, 6)}...${userAddress.slice(-4)}` : userAddress;
      vaultApi.historicalEvents.unshift({
        id: result.digest || `evt_${Date.now()}`,
        type: 'DEPOSIT',
        user: displayAddr,
        amountUsd: result.summary?.depositUsdcAmount || 0,
        sharesMinted: depEvt?.shares_minted || result.summary?.sharesToMint || 0,
        digest: result.digest,
        timestamp: new Date().toISOString()
      });
      console.log(`✅ [Live Deposit] user=${displayAddr} digest=${result.digest}`);
      statusCache.clear();
      const hedgeSyncTriggered = SUI_CONFIG.executionMode === 'LIVE' && SUI_CONFIG.hedging.enabled;
      if (hedgeSyncTriggered) {
        void triggerImmediateHedgeSync('deposit');
      }
      sendJson(res, 200, { success: true, result, hedgeSyncTriggered });
    } catch (err) {
      console.error('❌ [Deposit Execute Error]', err.message);
      sendJson(res, 400, {
        success: false,
        error: err.message,
        code: err.code || null,
        digest: err.digest || null,
        congestedObjects: err.congestedObjects || null
      });
    }
    return;
  }

  if (pathname === '/api/vault/withdraw/prepare' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const userAddress = payload.userAddress || payload.address;
      const shares = payload.shares || payload.sharesToBurn || '0';
      const vaultKey = payload.vault || payload.vaultKey || payload.vaultId;
      const { vaultConfig, dexService, builder } = getVaultRuntime(vaultKey);
      const vaultSnapshot = await dexService.getVaultSnapshot(vaultConfig.objectId);
      if (!vaultSnapshot) throw new Error(`Could not load live state for vault ${vaultConfig.label}`);

      const userShareObjects = await getUserVaultShareObjects(userAddress, vaultSnapshot);
      const ptbResult = await builder.buildActiveWithdrawPtb({
        userAddress,
        sharesToBurn: shares,
        vaultSnapshot,
        userShareObjects,
        vaultId: vaultConfig.objectId,
        vaultCallPackageId: vaultConfig.callPackageId,
        operatorCapId: vaultConfig.operatorCap,
        poolId: vaultConfig.poolId,
        exitInUsdc: Boolean(payload.exitInUsdc)
      });
      const response = await prepareLivePtbResponse({
        ptbResult,
        action: 'withdraw',
        userAddress,
        gasPriorityMultiplier: payload.gasPriorityMultiplier
      });
      console.log(`🔧 [${vaultConfig.shortLabel} Withdraw Prepare] user=${userAddress.slice(0, 8)}... shares=${shares} estUsdc=${response.summary.estOutUsdc} estSui=${response.summary.estOutSui}`);
      sendJson(res, 200, response);
    } catch (err) {
      console.error('❌ [Withdraw Prepare Error]', err.message);
      sendJson(res, 400, { success: false, error: err.message });
    }
    return;
  }

  if (pathname === '/api/vault/withdraw/execute' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const userAddress = payload.userAddress || payload.address;
      const result = await executeSignedLivePtb({
        bytesBase64: payload.bytes || payload.bytesBase64,
        signature: payload.signature,
        userAddress,
        expectedAction: 'withdraw'
      });
      const wdEvt = result.events.find((e) => e.type?.includes('::vault::WithdrawEvent'))?.json;
      const displayAddr = userAddress.length > 10 ? `${userAddress.slice(0, 6)}...${userAddress.slice(-4)}` : userAddress;
      const livePrice = await fetchLiveSuiPrice();
      const usdcOut = wdEvt?.amount_a_returned !== undefined ? Number(wdEvt.amount_a_returned) / 1e6 : (result.summary?.estOutUsdc || 0);
      const suiOut = wdEvt?.amount_b_returned !== undefined ? Number(wdEvt.amount_b_returned) / 1e9 : (result.summary?.estOutSui || 0);
      vaultApi.historicalEvents.unshift({
        id: result.digest || `evt_${Date.now()}`,
        type: 'WITHDRAW',
        user: displayAddr,
        amountUsd: Math.round((usdcOut + suiOut * livePrice) * 100) / 100,
        sharesBurned: wdEvt?.shares_burned || result.summary?.sharesToBurn || 0,
        digest: result.digest,
        timestamp: new Date().toISOString()
      });
      console.log(`✅ [Live Withdraw] user=${displayAddr} digest=${result.digest}`);
      statusCache.clear();
      const hedgeSyncTriggered = SUI_CONFIG.executionMode === 'LIVE' && SUI_CONFIG.hedging.enabled;
      if (hedgeSyncTriggered) {
        void triggerImmediateHedgeSync('withdraw');
      }
      sendJson(res, 200, { success: true, result, hedgeSyncTriggered });
    } catch (err) {
      console.error('❌ [Withdraw Execute Error]', err.message);
      sendJson(res, 400, {
        success: false,
        error: err.message,
        code: err.code || null,
        digest: err.digest || null,
        congestedObjects: err.congestedObjects || null
      });
    }
    return;
  }

  if (pathname === '/api/vault/deposit' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      if (SUI_CONFIG.executionMode === 'LIVE' && !payload.isDemo) {
        sendJson(res, 400, { success: false, error: 'LIVE mode requires wallet signature via /api/vault/deposit/prepare and /api/vault/deposit/execute' });
        return;
      }
      const userAddress = payload.userAddress || payload.address;
      const amountUsdc = parseFloat(payload.amountUsdc || payload.amount || 0);
      const simPrice = resolveScenarioPrice(await fetchLiveSuiPrice(), currentScenario);
      const result = await vaultApi.executeDeposit(userAddress, amountUsdc, simPrice);
      sendJson(res, 200, { success: true, result });
    } catch (err) {
      sendJson(res, 400, { success: false, error: err.message });
    }
    return;
  }

  if (pathname === '/api/vault/withdraw' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      if (SUI_CONFIG.executionMode === 'LIVE' && !payload.isDemo) {
        sendJson(res, 400, { success: false, error: 'LIVE mode requires wallet signature via /api/vault/withdraw/prepare and /api/vault/withdraw/execute' });
        return;
      }
      const userAddress = payload.userAddress || payload.address;
      const shares = parseFloat(payload.shares || payload.sharesToBurn || 0);
      const simPrice = resolveScenarioPrice(await fetchLiveSuiPrice(), currentScenario);
      const result = await vaultApi.executeWithdraw(userAddress, shares, simPrice);
      sendJson(res, 200, { success: true, result });
    } catch (err) {
      sendJson(res, 400, { success: false, error: err.message });
    }
    return;
  }

  if (pathname === '/api/simulate' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        if (payload.scenario) {
          currentScenario = payload.scenario;
        }
        const address = payload.address || null;
        const vaultKey = payload.vault || payload.vaultKey || payload.vaultId || null;
        const data = await getLiveState(address, vaultKey, true);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, scenario: currentScenario, state: data }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (pathname === '/api/deposit' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const amountUsdc = parseFloat(payload.amountUsdc || 1000);
        const vaultKey = payload.vault || payload.vaultKey || payload.vaultId || null;
        const { vaultConfig, dexService } = getVaultRuntime(vaultKey);
        const vaultId = vaultConfig.objectId;
        const vaultSnapshot = (vaultId && /^0x[0-9a-fA-F]{32,64}$/.test(vaultId))
          ? await dexService.getVaultSnapshot(vaultId).catch(() => null)
          : null;
        const livePrice = vaultSnapshot?.pool?.currentPrice || await fetchLiveSuiPrice();
        const sim = await vaultApi.simulateDeposit(amountUsdc, livePrice, vaultSnapshot, vaultConfig);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, simulation: sim }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // --- Static File Serving ---

  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
  };

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // Fallback to index.html for SPA
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, content2) => {
          if (err2) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
            res.end(content2);
          }
        });
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`🌊 BluSky-Sui Web Dashboard live at: http://localhost:${PORT}`);
  // Pre-warm vault caches silently so dashboard switches feel instantaneous
  setTimeout(() => {
    const catalog = getVaultCatalog();
    Object.values(catalog).forEach((v) => {
      if (v.objectId) {
        getLiveState(operatorAddress, v.key).catch(() => {});
      }
    });
  }, 400);
});

