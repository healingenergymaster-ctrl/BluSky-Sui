// src/services/monitor.mjs
// Continuous Monitoring Daemon & Rebalancing Orchestrator

import { SUI_CONFIG } from '../config.mjs';
import { TurbosService } from './turbos.mjs';
import { WalletManager } from './wallet.mjs';
import { RebalancePtbBuilder } from '../ptb/rebalanceBuilder.mjs';
import {
  computeTargetTickRange,
  calculateOptimalSwapForRebalance
} from '../strategy/rebalanceMath.mjs';

export class PositionMonitor {
  constructor(options = {}) {
    this.turbosService = options.turbosService || new TurbosService();
    this.wallet = options.wallet || new WalletManager();
    this.ptbBuilder = new RebalancePtbBuilder(this.turbosService);
    this.isRunning = false;
    this.timer = null;
    this.cycleCount = 0;
    this.history = [];
    this.onEvent = options.onEvent || null;
  }

  /**
   * Executes a single monitoring and evaluation cycle.
   */
  async checkOnce() {
    this.cycleCount++;
    const timestamp = new Date().toISOString();
    const ownerAddress = this.wallet.getAddress();

    // 1. Analyze Pool & Active Position
    const analysis = await this.turbosService.analyzePosition(
      SUI_CONFIG.pools.turbos_sui_usdc,
      SUI_CONFIG.targetPositionNft,
      ownerAddress
    );

    const record = {
      cycle: this.cycleCount,
      timestamp,
      price: analysis.pool.currentPrice,
      inRange: analysis.rangeMetrics.inRange,
      progressPct: analysis.rangeMetrics.progressPct,
      nearestBoundaryPct: analysis.rangeMetrics.nearestBoundaryDistancePct,
      feesUsd: analysis.accruedFees.totalFeesUsd,
      isDriftTriggered: analysis.rangeMetrics.isDriftTriggered,
      isViable: analysis.viability.isViable,
      shouldRebalance: analysis.shouldRebalance,
      actionTaken: 'HOLD'
    };

    // 2. Evaluate Rebalance Action
    if (analysis.shouldRebalance) {
      // Calculate new optimal target range
      const targetRange = computeTargetTickRange(
        analysis.pool.currentPrice,
        SUI_CONFIG.strategy.targetBandWidthPct,
        analysis.pool.tickSpacing,
        SUI_CONFIG.decimals.SUI,
        SUI_CONFIG.decimals.USDC
      );

      // Estimate total available capital from position ($20,000 pilot baseline)
      const estimatedSuiCapital = 4878; // ~$10,000 in SUI at $2.05
      const estimatedUsdcCapital = 10000; // $10,000 in USDC
      
      const swapPlan = calculateOptimalSwapForRebalance(
        estimatedSuiCapital,
        estimatedUsdcCapital,
        analysis.pool.currentPrice,
        targetRange.targetLowerPrice,
        targetRange.targetUpperPrice
      );

      // Build the atomic PTB
      const ptbResult = await this.ptbBuilder.buildAtomicRebalancePtb({
        poolId: analysis.pool.objectId,
        positionNftId: analysis.position.nftId,
        ownerAddress,
        newLowerTick: targetRange.lowerTick,
        newUpperTick: targetRange.upperTick,
        swapPlan
      });

      // Execute or Dry-Run Simulate
      const executionResult = await this.ptbBuilder.execute({
        ptbResult,
        signer: this.wallet
      });

      record.actionTaken = executionResult.mode === 'LIVE' ? 'REBALANCED_LIVE' : 'REBALANCED_SIMULATED';
      record.executionResult = executionResult;
      record.targetRange = targetRange;
    }

    this.history.push(record);
    if (this.history.length > 50) this.history.shift();

    if (this.onEvent) {
      this.onEvent(record, analysis);
    }

    return { record, analysis };
  }

  /**
   * Starts the continuous monitoring loop.
   */
  start(intervalMs = SUI_CONFIG.strategy.checkIntervalMs) {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[Daemon] BluSky-Sui Position Monitor started (Interval: ${intervalMs / 1000}s, Mode: ${SUI_CONFIG.executionMode})`);

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
