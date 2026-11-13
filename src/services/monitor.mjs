// src/services/monitor.mjs
// Dual-DEX Continuous Monitoring Daemon & Automated Rebalancing Orchestrator (Cetus + Turbos)

import { SUI_CONFIG } from '../config.mjs';
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

    // Delta-neutral hedging engine
    this.hedgingEngine = options.hedgingEngine || new HedgingEngine({
      turbosService: this.turbosService
    });

    this.isRunning = false;
    this.timer = null;
    this.cycleCount = 0;
    this.history = [];
    this.onEvent = options.onEvent || null;
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

  /**
   * Executes a single monitoring, hedging, yield-routing, and evaluation cycle.
   */
  async checkOnce(simulatedPrice = null) {
    this.cycleCount++;
    const timestamp = new Date().toISOString();
    const ownerAddress = this.wallet.getAddress();

    // 1. Fetch Primary and Secondary DEX Pool States
    const isLiveMode = SUI_CONFIG.executionMode === 'LIVE';
    const liveVaultSnapshot = (this.primaryDex === 'cetus' && isLiveMode)
      ? await this.cetusService.getVaultSnapshot(SUI_CONFIG.vault.objectId).catch(() => null)
      : null;

    if (liveVaultSnapshot?.isRebalancing) {
      throw new Error(`Vault ${liveVaultSnapshot.vaultId} is currently locked in an active rebalance.`);
    }

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
          SUI_CONFIG.vault.packageId,
          ownerAddress
        );
        if (liveFees) {
          cetusAnalysis.accruedFees = liveFees;
          cetusAnalysis.viability = evaluateEconomicViability(
            liveFees.totalFeesUsd,
            0.008,
            SUI_CONFIG.strategy.maxCostToFeeRatio,
            SUI_CONFIG.strategy.minFeesBeforeRebalanceUsd,
            !cetusAnalysis.rangeMetrics.inRange
          );
          cetusAnalysis.shouldRebalance =
            cetusAnalysis.rangeMetrics.isDriftTriggered && cetusAnalysis.viability.isViable;
        }
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
            vaultPackageId: SUI_CONFIG.vault.packageId,
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
    }

    this.history.push(record);
    if (this.history.length > 50) this.history.shift();

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
