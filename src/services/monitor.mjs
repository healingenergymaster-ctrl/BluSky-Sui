// src/services/monitor.mjs
// Dual-DEX Continuous Monitoring Daemon & Automated Rebalancing Orchestrator (Cetus + Turbos)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SUI_CONFIG, getVaultCatalog, resolveVaultConfig } from '../config.mjs';
import { CetusService } from './cetus.mjs';
import { TurbosService } from './turbos.mjs';
import { WalletManager } from './wallet.mjs';
import { CetusRebalancePtbBuilder } from '../ptb/cetusRebalanceBuilder.mjs';
import { RebalancePtbBuilder } from '../ptb/rebalanceBuilder.mjs';
import { HedgingEngine } from '../hedging/hedgingEngine.mjs';
import {
  computeTargetTickRange,
  calculateOptimalSwapForRebalance,
  computeCetusFlashSwapAndAddPlan,
  evaluateEconomicViability
} from '../strategy/rebalanceMath.mjs';

export class PositionMonitor {
  constructor(options = {}) {
    this.primaryDex = options.primaryDex || SUI_CONFIG.yieldRouting.primaryDex || 'cetus';
    this.cetusService = options.cetusService || new CetusService();
    this.turbosService = options.turbosService || new TurbosService();
    this.wallet = options.wallet || new WalletManager();

    // PTB Builders for both protocols
    this.cetusPtbBuilder = new CetusRebalancePtbBuilder(this.cetusService);
    this.turbosPtbBuilder = new RebalancePtbBuilder(this.turbosService);

    // Delta-neutral hedging engine (uses operator wallet for live Bluefin Pro auth)
    this.hedgingEngine = options.hedgingEngine || new HedgingEngine({
      turbosService: this.turbosService
    });

    this.isRunning = false;
    this.timer = null;
    this.cycleCount = 0;
    this.history = [];
    this.liveEvents = [];
    this.vaultStatuses = {};
    this.onEvent = options.onEvent || null;
    this.statusFilePath = options.statusFilePath || path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../.monitor-status.json'
    );
  }

  _persistStatus(record, primaryAnalysis, liveVaultSnapshot) {
    try {
      const payload = {
        updatedAt: record.timestamp,
        pid: process.pid,
        cycle: record.cycle,
        network: SUI_CONFIG.network,
        executionMode: SUI_CONFIG.executionMode,
        hedgingEnabled: SUI_CONFIG.hedging.enabled,
        primaryDex: this.primaryDex,
        vaultId: liveVaultSnapshot?.vaultId || SUI_CONFIG.vault.objectId,
        positionNftId: primaryAnalysis.position?.nftId || null,
        isRebalancing: Boolean(liveVaultSnapshot?.isRebalancing),
        price: record.price,
        lowerPrice: primaryAnalysis.rangeMetrics?.priceLower,
        upperPrice: primaryAnalysis.rangeMetrics?.priceUpper,
        lowerTick: primaryAnalysis.position?.lowerTick,
        upperTick: primaryAnalysis.position?.upperTick,
        progressPct: record.progressPct,
        nearestBoundaryPct: record.nearestBoundaryPct,
        inRange: record.inRange,
        isDriftTriggered: record.isDriftTriggered,
        feesUsd: record.feesUsd,
        viabilityReason: primaryAnalysis.viability?.reason || '',
        actionTaken: record.actionTaken,
        lastDigest: record.executionResult?.digest || null,
        yieldRouting: record.yieldRouting,
        hedging: record.hedgeReport ? {
          timestamp: record.hedgeReport.timestamp,
          market: record.hedgeReport.perpStatus?.market,
          spotDeltaSui: record.hedgeReport.spotMetrics?.spotDeltaSui,
          spotDeltaUsd: record.hedgeReport.spotMetrics?.spotDeltaUsd,
          perpShortSizeSui: record.hedgeReport.perpStatus?.shortSizeSui,
          perpShortNotionalUsd: record.hedgeReport.perpStatus?.notionalUsd,
          netDeltaSui: record.hedgeReport.deltaStatus?.netDeltaSui,
          netDeltaUsd: record.hedgeReport.deltaStatus?.netDeltaUsd,
          deltaDriftPct: record.hedgeReport.deltaStatus?.deltaDriftPct,
          adjustmentAction: record.hedgeReport.deltaStatus?.adjustmentAction,
          adjustmentResult: record.hedgeReport.adjustmentResult,
          hedgeCapacity: record.hedgeReport.hedgeCapacity || null,
          accountExists: record.hedgeReport.perpStatus?.accountExists,
          accountNeedsDeposit: record.hedgeReport.perpStatus?.accountNeedsDeposit,
          marginAvailableUsd: record.hedgeReport.perpStatus?.marginAvailableUsd,
          totalAccountValueUsd: record.hedgeReport.perpStatus?.totalAccountValueUsd,
          fundingApr: record.hedgeReport.fundingInfo?.annualizedApr,
          fundingSource: record.hedgeReport.fundingInfo?.source,
          vaultBreakdown: record.hedgeReport.vaultBreakdown
        } : null,
        vaults: this.vaultStatuses,
        recentEvents: this.liveEvents.slice(0, 10)
      };
      const tmpPath = `${this.statusFilePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
      fs.renameSync(tmpPath, this.statusFilePath);
    } catch {
      // Never allow telemetry persistence failure to disrupt monitoring
    }
  }

  /**
   * Switches the active DEX for liquidity management.
   * @param {'cetus' | 'turbos'} dex 
   */
  setPrimaryDex(dex) {
    if (dex === 'cetus' || dex === 'turbos') {
      this.primaryDex = dex;
      console.log(`[Daemon] Active DEX switched to: ${dex.toUpperCase()}`);
    }
  }

  /**
   * Evaluates cross-DEX yield routing spreads between Cetus and Turbos.
   * @param {number} cetusApr 
   * @param {number} turbosApr 
   */
  evaluateYieldRouting(cetusApr, turbosApr) {
    const minSpread = SUI_CONFIG.yieldRouting.minAprSpreadPct || 15.0;
    const spreadPct = Math.round((cetusApr - turbosApr) * 10) / 10;
    const absSpread = Math.abs(spreadPct);

    let recommendation = 'HOLD_CURRENT_DEX';
    let shouldMigrate = false;
    let targetDex = this.primaryDex;

    if (this.primaryDex === 'turbos' && spreadPct >= minSpread) {
      recommendation = `ROTATE_TO_CETUS (Cetus +${spreadPct}% APR spread exceeds ${minSpread}% threshold)`;
      shouldMigrate = true;
      targetDex = 'cetus';
    } else if (this.primaryDex === 'cetus' && (turbosApr - cetusApr) >= minSpread) {
      const turbosAdvantage = Math.round((turbosApr - cetusApr) * 10) / 10;
      recommendation = `ROTATE_TO_TURBOS (Turbos +${turbosAdvantage}% APR spread exceeds ${minSpread}% threshold)`;
      shouldMigrate = true;
      targetDex = 'turbos';
    } else {
      recommendation = `OPTIMAL (${this.primaryDex.toUpperCase()} is yielding competitively; spread ${spreadPct}% is within safe bounds)`;
    }

    return {
      cetusApr,
      turbosApr,
      spreadPct,
      absSpread,
      minSpreadThresholdPct: minSpread,
      recommendation,
      shouldMigrate,
      targetDex
    };
  }

  async _rebalanceLiveVault(vaultCfg, liveVaultSnapshot, analysis, targetRange, ownerAddress) {
    const isTurbos = vaultCfg.dex === 'turbos';
    const builder = isTurbos ? this.turbosPtbBuilder : this.cetusPtbBuilder;
    const dexService = isTurbos ? this.turbosService : this.cetusService;
    const swapPlan = computeCetusFlashSwapAndAddPlan({
      rawCoinA: liveVaultSnapshot.totalRawA,
      rawCoinB: liveVaultSnapshot.totalRawB,
      poolSqrtPriceX64: analysis.pool.sqrtPriceX64,
      poolLiquidity: analysis.pool.liquidity,
      lowerTick: targetRange.lowerTick,
      upperTick: targetRange.upperTick,
      feeRateBps: analysis.pool.feeRate || vaultCfg.feeRateBps || 500,
      slippagePct: Math.max(Number(SUI_CONFIG.strategy.maxSlippagePct || 0.5), 1.0)
    });

    const ptbOptions = {
      poolId: analysis.pool.objectId,
      positionNftId: liveVaultSnapshot.positionNftId,
      ownerAddress,
      currentTick: analysis.pool.currentTick,
      newLowerTick: targetRange.lowerTick,
      newUpperTick: targetRange.upperTick,
      swapPlan,
      accruedFeesUsd: analysis.accruedFees?.totalFeesUsd || 0,
      isLiveRebalance: true,
      vaultId: liveVaultSnapshot.vaultId,
      vaultPackageId: vaultCfg.callPackageId || vaultCfg.packageId,
      operatorCapId: vaultCfg.operatorCap,
      coinTypeA: liveVaultSnapshot.coinTypeA,
      coinTypeB: liveVaultSnapshot.coinTypeB
    };

    if (isTurbos) {
      ptbOptions.feeType = analysis.pool.feeType;
      ptbOptions.positionLiquidity = liveVaultSnapshot.position?.liquidity || '0';
      ptbOptions.rewarderDetails = analysis.pool.rewarderDetails || [];
    } else {
      ptbOptions.redeployFixAmount = swapPlan.redeployFixAmount;
      ptbOptions.isFixA = swapPlan.isFixA;
      ptbOptions.rewardCoins = analysis.pool.rewarders || [];
      ptbOptions.rewarderGlobalVaultId = dexService.contracts.rewarderGlobalVaultId;
    }

    const ptbResult = await builder.buildAtomicRebalancePtb(ptbOptions);
    return builder.execute({ ptbResult, signer: this.wallet });
  }

  async _evaluateLiveVault(vaultCfg, ownerAddress, simulatedPrice, timestamp) {
    const isTurbos = vaultCfg.dex === 'turbos';
    const dexService = isTurbos ? this.turbosService : this.cetusService;
    const liveVaultSnapshot = await dexService.getVaultSnapshot(vaultCfg.objectId).catch(() => null);
    if (!liveVaultSnapshot?.positionNftId || !liveVaultSnapshot?.pool || liveVaultSnapshot.isRebalancing) {
      return null;
    }

    const analysis = await dexService.analyzePosition(
      liveVaultSnapshot.pool.objectId,
      liveVaultSnapshot.position.lowerTick,
      liveVaultSnapshot.position.upperTick,
      liveVaultSnapshot.positionNftId,
      simulatedPrice
    );

    const liveFees = await dexService.getVaultAccruedFees(
      liveVaultSnapshot.vaultId,
      analysis.pool,
      vaultCfg.callPackageId || vaultCfg.packageId,
      ownerAddress,
      liveVaultSnapshot.position
    );
    const resolvedFees = liveFees || {
      feeA_Sui: 0,
      feeB_Usdc: 0,
      totalFeesUsd: 0,
      protocolFeeUsd: 0,
      compoundedYieldUsd: 0,
      isSimulated: false
    };
    analysis.accruedFees = resolvedFees;
    analysis.viability = evaluateEconomicViability(
      resolvedFees.totalFeesUsd,
      0.008,
      SUI_CONFIG.strategy.maxCostToFeeRatio,
      SUI_CONFIG.strategy.minFeesBeforeRebalanceUsd,
      !analysis.rangeMetrics.inRange
    );
    analysis.shouldRebalance = analysis.rangeMetrics.isDriftTriggered && analysis.viability.isViable;

    let actionTaken = 'HOLD';
    let executionResult = null;
    let targetRange = null;

    if (analysis.shouldRebalance) {
      const poolIsCoinASui = analysis.pool.isCoinASui !== undefined
        ? Boolean(analysis.pool.isCoinASui)
        : Boolean(vaultCfg.isCoinASui);
      const decA = analysis.pool.decimalsA || (poolIsCoinASui ? SUI_CONFIG.decimals.SUI : SUI_CONFIG.decimals.USDC);
      const decB = analysis.pool.decimalsB || (poolIsCoinASui ? SUI_CONFIG.decimals.USDC : SUI_CONFIG.decimals.SUI);

      targetRange = computeTargetTickRange(
        analysis.pool.currentPrice,
        SUI_CONFIG.strategy.targetBandWidthPct,
        analysis.pool.tickSpacing || vaultCfg.tickSpacing || 10,
        decA,
        decB,
        poolIsCoinASui
      );
      executionResult = await this._rebalanceLiveVault(vaultCfg, liveVaultSnapshot, analysis, targetRange, ownerAddress);
      actionTaken = executionResult.mode === 'LIVE' ? 'REBALANCED_LIVE' : 'REBALANCED_SIMULATED';

      if (executionResult.mode === 'LIVE') {
        this.liveEvents.unshift({
          id: executionResult.digest || `reb_${Date.now()}`,
          type: 'REBALANCE',
          vaultKey: vaultCfg.key,
          vaultLabel: vaultCfg.shortLabel,
          txDigest: executionResult.digest || null,
          oldRange: `$${analysis.rangeMetrics.priceLower.toFixed(4)} - $${analysis.rangeMetrics.priceUpper.toFixed(4)}`,
          newRange: `$${targetRange.targetLowerPrice.toFixed(4)} - $${targetRange.targetUpperPrice.toFixed(4)}`,
          costUsd: 0.008,
          timestamp
        });
        if (this.liveEvents.length > 20) this.liveEvents.pop();
      }
    }

    this.vaultStatuses[vaultCfg.key] = {
      vaultId: liveVaultSnapshot.vaultId,
      dex: vaultCfg.dex,
      feeTier: vaultCfg.feeTier,
      positionNftId: liveVaultSnapshot.positionNftId,
      price: analysis.pool.currentPrice,
      inRange: analysis.rangeMetrics.inRange,
      progressPct: analysis.rangeMetrics.progressPct,
      feesUsd: resolvedFees.totalFeesUsd,
      actionTaken,
      lastDigest: executionResult?.digest || this.vaultStatuses[vaultCfg.key]?.lastDigest || null,
      updatedAt: timestamp
    };

    return { vaultCfg, liveVaultSnapshot, analysis, actionTaken, executionResult, targetRange };
  }

  /**
   * Executes a single monitoring, hedging, yield-routing, and evaluation cycle across all live vaults.
   */
  async checkOnce(simulatedPrice = null) {
    this.cycleCount++;
    const timestamp = new Date().toISOString();
    const ownerAddress = this.wallet.getAddress();
    const isLiveMode = SUI_CONFIG.executionMode === 'LIVE';
    const catalog = getVaultCatalog();
    const activeVaults = Object.values(catalog).filter((v) => v.objectId && v.operatorCap);

    if (isLiveMode && activeVaults.length > 0) {
      const results = [];
      for (const vCfg of activeVaults) {
        try {
          const r = await this._evaluateLiveVault(vCfg, ownerAddress, simulatedPrice, timestamp);
          if (r) results.push(r);
        } catch (err) {
          console.warn(`[Daemon ${vCfg.shortLabel}] Cycle skip: ${err.message}`);
        }
      }

      if (results.length === 0) {
        throw new Error('No live Mainnet vault positions available; skipping cycle safely.');
      }

      const preferred = results.find((r) => r.vaultCfg.key === resolveVaultConfig().key) || results[0];
      const primaryAnalysis = preferred.analysis;
      const cetusAnalysis = results.find((r) => r.vaultCfg.dex === 'cetus')?.analysis
        || await this.cetusService.analyzePosition(catalog.cetus005.poolId, -71280, -69060, '0x_cetus_bench', simulatedPrice);
      const turbosAnalysis = results.find((r) => r.vaultCfg.dex === 'turbos')?.analysis
        || await this.turbosService.analyzePosition(catalog.turbos005.poolId, -73200, -71200, '0x_turbos_bench', simulatedPrice);

      const cetusApr = cetusAnalysis.metrics ? cetusAnalysis.metrics.grossApr : 250.0;
      const turbosApr = turbosAnalysis.metrics ? turbosAnalysis.metrics.grossApr : 180.0;
      const yieldRouting = this.evaluateYieldRouting(cetusApr, turbosApr);

      let hedgeReport = null;
      try {
        hedgeReport = await this.hedgingEngine.evaluateMultiVaultHedge(results, simulatedPrice, {
          executeOrders: SUI_CONFIG.hedging.enabled
        });
      } catch (hedgeErr) {
        console.warn(`[Daemon Hedging] Shadow/Live Bluefin Pro evaluation skipped: ${hedgeErr.message}`);
      }

      const anyRebalanced = results.find((r) => r.executionResult?.mode === 'LIVE');
      const record = {
        cycle: this.cycleCount,
        timestamp,
        primaryDex: preferred.vaultCfg.dex,
        monitoredVaults: results.map((r) => r.vaultCfg.key),
        price: primaryAnalysis.pool.currentPrice,
        inRange: primaryAnalysis.rangeMetrics.inRange,
        progressPct: primaryAnalysis.rangeMetrics.progressPct,
        nearestBoundaryPct: primaryAnalysis.rangeMetrics.nearestBoundaryDistancePct,
        feesUsd: primaryAnalysis.accruedFees?.totalFeesUsd || 0,
        isDriftTriggered: primaryAnalysis.rangeMetrics.isDriftTriggered,
        isViable: primaryAnalysis.viability?.isViable ?? true,
        shouldRebalance: results.some((r) => r.analysis.shouldRebalance),
        yieldRouting,
        hedgeReport,
        actionTaken: anyRebalanced ? 'REBALANCED_LIVE' : 'HOLD',
        executionResult: anyRebalanced?.executionResult || null
      };

      this.history.push(record);
      if (this.history.length > 50) this.history.shift();
      this._persistStatus(record, primaryAnalysis, preferred.liveVaultSnapshot);
      if (this.onEvent) this.onEvent(record, primaryAnalysis, hedgeReport);
      return { record, primaryAnalysis, cetusAnalysis, turbosAnalysis, hedgeReport };
    }

    // DRY_RUN / offline simulation path
    const liveVaultSnapshot = null;

    let primaryAnalysis;
    let turbosAnalysis;
    let cetusAnalysis;

    if (this.primaryDex === 'cetus') {
      const targetPool = liveVaultSnapshot?.pool?.objectId || SUI_CONFIG.pools.cetus_sui_usdc;
      const posLower = liveVaultSnapshot?.position?.lowerTick ?? -71280;
      const posUpper = liveVaultSnapshot?.position?.upperTick ?? -69060;
      const posNftId = liveVaultSnapshot?.positionNftId || '0x_cetus_position_nft_demo';

      cetusAnalysis = await this.cetusService.analyzePosition(
        targetPool,
        posLower,
        posUpper,
        posNftId,
        simulatedPrice
      );
      if (isLiveMode && liveVaultSnapshot?.positionNftId) {
        const liveFees = await this.cetusService.getVaultAccruedFees(
          liveVaultSnapshot.vaultId,
          cetusAnalysis.pool,
          SUI_CONFIG.vault.callPackageId || SUI_CONFIG.vault.packageId,
          ownerAddress
        );
        const resolvedFees = liveFees || {
          feeA_Sui: 0,
          feeB_Usdc: 0,
          totalFeesUsd: 0,
          protocolFeeUsd: 0,
          compoundedYieldUsd: 0,
          isSimulated: false
        };
        cetusAnalysis.accruedFees = resolvedFees;
        cetusAnalysis.viability = evaluateEconomicViability(
          resolvedFees.totalFeesUsd,
          0.008,
          SUI_CONFIG.strategy.maxCostToFeeRatio,
          SUI_CONFIG.strategy.minFeesBeforeRebalanceUsd,
          !cetusAnalysis.rangeMetrics.inRange
        );
        cetusAnalysis.shouldRebalance =
          cetusAnalysis.rangeMetrics.isDriftTriggered && cetusAnalysis.viability.isViable;
      }
      primaryAnalysis = cetusAnalysis;

      turbosAnalysis = await this.turbosService.analyzePosition(
        SUI_CONFIG.pools.turbos_sui_usdc,
        SUI_CONFIG.targetPositionNft,
        ownerAddress
      );
    } else {
      turbosAnalysis = await this.turbosService.analyzePosition(
        SUI_CONFIG.pools.turbos_sui_usdc,
        SUI_CONFIG.targetPositionNft,
        ownerAddress
      );
      if (simulatedPrice !== null) {
        turbosAnalysis.pool.currentPrice = simulatedPrice;
      }
      primaryAnalysis = turbosAnalysis;

      cetusAnalysis = await this.cetusService.analyzePosition(
        SUI_CONFIG.pools.cetus_sui_usdc,
        -71280,
        -69060,
        '0x_cetus_position_nft_demo',
        simulatedPrice
      );
    }

    // Apply simulated price override if provided (for stress testing)
    if (simulatedPrice !== null) {
      primaryAnalysis.pool.currentPrice = simulatedPrice;
    }

    // 2. Evaluate Cross-DEX Yield Spread
    const cetusApr = cetusAnalysis.metrics ? cetusAnalysis.metrics.grossApr : 250.0;
    const turbosApr = turbosAnalysis.metrics ? turbosAnalysis.metrics.grossApr : 180.0;
    const yieldRouting = this.evaluateYieldRouting(cetusApr, turbosApr);

    const record = {
      cycle: this.cycleCount,
      timestamp,
      primaryDex: this.primaryDex,
      price: primaryAnalysis.pool.currentPrice,
      inRange: primaryAnalysis.rangeMetrics.inRange,
      progressPct: primaryAnalysis.rangeMetrics.progressPct,
      nearestBoundaryPct: primaryAnalysis.rangeMetrics.nearestBoundaryDistancePct,
      feesUsd: primaryAnalysis.accruedFees ? primaryAnalysis.accruedFees.totalFeesUsd : 45.0,
      isDriftTriggered: primaryAnalysis.rangeMetrics.isDriftTriggered,
      isViable: primaryAnalysis.viability ? primaryAnalysis.viability.isViable : true,
      shouldRebalance: primaryAnalysis.shouldRebalance,
      yieldRouting,
      actionTaken: 'HOLD'
    };

    // 3. Evaluate Delta-Neutral Hedging (Phase 2)
    let hedgeReport = null;
    if (SUI_CONFIG.hedging.enabled) {
      hedgeReport = await this.hedgingEngine.evaluateAndHedge(primaryAnalysis, simulatedPrice);
      record.hedgeReport = hedgeReport;
    }

    // 4. Evaluate CLMM Tick Rebalance Action
    if (primaryAnalysis.shouldRebalance) {
      const poolIsCoinASui = primaryAnalysis.pool.isCoinASui !== undefined
        ? Boolean(primaryAnalysis.pool.isCoinASui)
        : true;
      const decA = primaryAnalysis.pool.decimalsA || (poolIsCoinASui ? SUI_CONFIG.decimals.SUI : SUI_CONFIG.decimals.USDC);
      const decB = primaryAnalysis.pool.decimalsB || (poolIsCoinASui ? SUI_CONFIG.decimals.USDC : SUI_CONFIG.decimals.SUI);

      // Calculate new optimal target range centered on current spot
      const targetRange = computeTargetTickRange(
        primaryAnalysis.pool.currentPrice,
        SUI_CONFIG.strategy.targetBandWidthPct,
        primaryAnalysis.pool.tickSpacing || 60,
        decA,
        decB,
        poolIsCoinASui
      );

      let executionResult;

      if (this.primaryDex === 'cetus') {
        let swapPlan;
        let ptbOptions = {
          poolId: primaryAnalysis.pool.objectId,
          positionNftId: liveVaultSnapshot?.positionNftId || '0x_cetus_active_vault_position',
          ownerAddress,
          currentTick: primaryAnalysis.pool.currentTick,
          newLowerTick: targetRange.lowerTick,
          newUpperTick: targetRange.upperTick,
          accruedFeesUsd: record.feesUsd
        };

        if (isLiveMode && liveVaultSnapshot?.positionNftId) {
          swapPlan = computeCetusFlashSwapAndAddPlan({
            rawCoinA: liveVaultSnapshot.totalRawA,
            rawCoinB: liveVaultSnapshot.totalRawB,
            poolSqrtPriceX64: primaryAnalysis.pool.sqrtPriceX64,
            poolLiquidity: primaryAnalysis.pool.liquidity,
            lowerTick: targetRange.lowerTick,
            upperTick: targetRange.upperTick,
            feeRateBps: primaryAnalysis.pool.feeRate || 2500
          });
          ptbOptions = {
            ...ptbOptions,
            swapPlan,
            isLiveRebalance: true,
            vaultId: liveVaultSnapshot.vaultId,
            vaultPackageId: SUI_CONFIG.vault.callPackageId || SUI_CONFIG.vault.packageId,
            operatorCapId: SUI_CONFIG.vault.operatorCap,
            coinTypeA: liveVaultSnapshot.coinTypeA,
            coinTypeB: liveVaultSnapshot.coinTypeB,
            redeployFixAmount: swapPlan.redeployFixAmount,
            isFixA: swapPlan.isFixA,
            rewardCoins: primaryAnalysis.pool.rewarders || [],
            rewarderGlobalVaultId: this.cetusService.contracts.rewarderGlobalVaultId
          };
        } else {
          const estimatedSuiCapital = 4878;
          const estimatedUsdcCapital = 10000;
          swapPlan = calculateOptimalSwapForRebalance(
            estimatedSuiCapital,
            estimatedUsdcCapital,
            primaryAnalysis.pool.currentPrice,
            targetRange.targetLowerPrice,
            targetRange.targetUpperPrice
          );
          ptbOptions.swapPlan = swapPlan;
        }

        const ptbResult = await this.cetusPtbBuilder.buildAtomicRebalancePtb(ptbOptions);

        executionResult = await this.cetusPtbBuilder.execute({
          ptbResult,
          signer: this.wallet
        });
      } else {
        const estimatedSuiCapital = 4878;
        const estimatedUsdcCapital = 10000;
        const swapPlan = calculateOptimalSwapForRebalance(
          estimatedSuiCapital,
          estimatedUsdcCapital,
          primaryAnalysis.pool.currentPrice,
          targetRange.targetLowerPrice,
          targetRange.targetUpperPrice
        );
        const ptbResult = await this.turbosPtbBuilder.buildAtomicRebalancePtb({
          poolId: primaryAnalysis.pool.objectId,
          positionNftId: primaryAnalysis.position ? primaryAnalysis.position.nftId : '0x_turbos_nft',
          ownerAddress,
          newLowerTick: targetRange.lowerTick,
          newUpperTick: targetRange.upperTick,
          swapPlan
        });

        executionResult = await this.turbosPtbBuilder.execute({
          ptbResult,
          signer: this.wallet
        });
      }

      record.actionTaken = executionResult.mode === 'LIVE' ? 'REBALANCED_LIVE' : 'REBALANCED_SIMULATED';
      record.executionResult = executionResult;
      record.targetRange = targetRange;

      if (executionResult.mode === 'LIVE') {
        this.liveEvents.unshift({
          id: executionResult.digest || `reb_${Date.now()}`,
          type: 'REBALANCE',
          txDigest: executionResult.digest || null,
          oldRange: `$${primaryAnalysis.rangeMetrics.priceLower.toFixed(4)} - $${primaryAnalysis.rangeMetrics.priceUpper.toFixed(4)}`,
          newRange: `$${targetRange.targetLowerPrice.toFixed(4)} - $${targetRange.targetUpperPrice.toFixed(4)}`,
          costUsd: 0.008,
          timestamp
        });
        if (this.liveEvents.length > 20) this.liveEvents.pop();
      }
    }

    this.history.push(record);
    if (this.history.length > 50) this.history.shift();
    this._persistStatus(record, primaryAnalysis, liveVaultSnapshot);

    if (this.onEvent) {
      this.onEvent(record, primaryAnalysis, hedgeReport);
    }

    return { record, primaryAnalysis, cetusAnalysis, turbosAnalysis, hedgeReport };
  }

  /**
   * Starts the continuous monitoring loop.
   */
  start(intervalMs = SUI_CONFIG.strategy.checkIntervalMs) {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[Daemon] BluSky-Sui Position Monitor started (Primary DEX: ${this.primaryDex.toUpperCase()}, Interval: ${intervalMs / 1000}s, Mode: ${SUI_CONFIG.executionMode})`);

    // Initial check immediately
    this.checkOnce().catch(err => console.error('[Daemon Error]', err.message));

    this.timer = setInterval(async () => {
      try {
        await this.checkOnce();
      } catch (err) {
        console.error('[Daemon Cycle Error]', err.message);
      }
    }, intervalMs);
  }

  /**
   * Stops the continuous monitoring loop.
   */
  stop() {
    if (!this.isRunning) return;
    clearInterval(this.timer);
    this.isRunning = false;
    console.log('[Daemon] BluSky-Sui Position Monitor stopped.');
  }
}
