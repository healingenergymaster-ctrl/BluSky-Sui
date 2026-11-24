// src/hedging/hedgingEngine.mjs
// Delta-Neutral Hedging Engine: Synchronizes Multi-Vault CLMM Spot Delta & Bluefin Pro Perps

import { SUI_CONFIG } from '../config.mjs';
import { TurbosService } from '../services/turbos.mjs';
import { BluefinService } from '../services/bluefin.mjs';
import {
  calculateClmmSpotDelta,
  evaluateDeltaHedgeStatus,
  computeMarketNeutralApy
} from './deltaMath.mjs';

export class HedgingEngine {
  constructor(options = {}) {
    this.turbosService = options.turbosService || new TurbosService();
    const isLive = SUI_CONFIG.executionMode === 'LIVE';
    const virtualShortDefault = isLive ? 0 : (options.initialShortSizeSui ?? 371.729);
    this.bluefinService = options.bluefinService || new BluefinService({
      initialShortSizeSui: options.initialShortSizeSui !== undefined ? options.initialShortSizeSui : virtualShortDefault,
      forceVirtual: options.forceVirtual
    });
    this.history = [];
  }

  /**
   * Evaluates delta-neutral portfolio health for a single CLMM analysis or live vault snapshot.
   */
  async evaluateAndHedge(clmmAnalysis, simulatedPrice = null, options = {}) {
    const currentPrice = simulatedPrice !== null ? simulatedPrice : clmmAnalysis.pool.currentPrice;
    const position = clmmAnalysis.position;

    // Use real vault snapshot holdings when provided; otherwise derive spot delta from CLMM tick math
    let spotMetrics;
    if (options.spotDeltaSui !== undefined) {
      const spotDeltaSui = Number(options.spotDeltaSui) || 0;
      const usdcHeld = Number(options.usdcHeld) || 0;
      const spotDeltaUsd = spotDeltaSui * currentPrice;
      spotMetrics = {
        spotDeltaSui,
        spotDeltaUsd,
        usdcHeld,
        totalValueUsd: spotDeltaUsd + usdcHeld
      };
    } else {
      spotMetrics = calculateClmmSpotDelta(
        position.liquidity,
        currentPrice,
        clmmAnalysis.rangeMetrics.priceLower,
        clmmAnalysis.rangeMetrics.priceUpper
      );
    }

    const executeOrders = options.executeOrders !== undefined
      ? options.executeOrders
      : SUI_CONFIG.hedging.enabled;

    return await this._buildAndMaybeRehedge({
      currentPrice,
      spotMetrics,
      accruedFeesUsd: clmmAnalysis.accruedFees?.totalFeesUsd || 0,
      grossApr: options.grossApr ?? clmmAnalysis.metrics?.grossApr,
      inRange: clmmAnalysis.rangeMetrics?.inRange ?? true,
      executeOrders,
      vaultBreakdown: options.vaultBreakdown || null
    });
  }

  /**
   * Evaluates combined spot SUI exposure across multiple live vaults (e.g., cetus005, turbos005)
   * against the operator's Bluefin Pro short position.
   */
  async evaluateMultiVaultHedge(vaultEvaluations = [], simulatedPrice = null, options = {}) {
    let totalSpotSui = 0;
    let totalUsdcHeld = 0;
    let totalFeesUsd = 0;
    let weightedAprNumerator = 0;
    let totalTvlUsd = 0;
    let currentPrice = simulatedPrice;
    const vaultBreakdown = [];

    for (const entry of vaultEvaluations) {
      const snap = entry.liveVaultSnapshot;
      const analysis = entry.analysis;
      const price = simulatedPrice ?? analysis?.pool?.currentPrice ?? 0;
      if (!currentPrice && price > 0) currentPrice = price;

      const vaultSui = snap ? Number(snap.totalSui || 0) : 0;
      const vaultUsdc = snap ? Number(snap.totalUsdc || 0) : 0;
      const vaultTvl = vaultUsdc + vaultSui * (price || currentPrice || 0);
      const vaultApr = analysis?.metrics?.grossApr ?? analysis?.apr?.grossApr ?? 0;

      totalSpotSui += vaultSui;
      totalUsdcHeld += vaultUsdc;
      totalFeesUsd += analysis?.accruedFees?.totalFeesUsd || 0;
      totalTvlUsd += vaultTvl;
      weightedAprNumerator += vaultTvl * vaultApr;

      vaultBreakdown.push({
        key: entry.vaultCfg?.key,
        label: entry.vaultCfg?.shortLabel || entry.vaultCfg?.key,
        spotSui: Math.round(vaultSui * 10000) / 10000,
        usdcHeld: Math.round(vaultUsdc * 10000) / 10000,
        tvlUsd: Math.round(vaultTvl * 10000) / 10000,
        grossApr: vaultApr
      });
    }

    const resolvedPrice = currentPrice || 0.725;
    const spotDeltaUsd = totalSpotSui * resolvedPrice;
    const spotMetrics = {
      spotDeltaSui: totalSpotSui,
      spotDeltaUsd,
      usdcHeld: totalUsdcHeld,
      totalValueUsd: spotDeltaUsd + totalUsdcHeld
    };

    const weightedGrossApr = totalTvlUsd > 0 ? (weightedAprNumerator / totalTvlUsd) : 0;
    const executeOrders = options.executeOrders !== undefined
      ? options.executeOrders
      : SUI_CONFIG.hedging.enabled;

    return await this._buildAndMaybeRehedge({
      currentPrice: resolvedPrice,
      spotMetrics,
      accruedFeesUsd: totalFeesUsd,
      grossApr: Math.round(weightedGrossApr * 10) / 10,
      inRange: vaultEvaluations.some((e) => e.analysis?.rangeMetrics?.inRange),
      executeOrders,
      vaultBreakdown
    });
  }

  async _buildAndMaybeRehedge({
    currentPrice,
    spotMetrics,
    accruedFeesUsd,
    grossApr,
    inRange,
    executeOrders,
    vaultBreakdown
  }) {
    const [perpStatus, fundingInfo] = await Promise.all([
      this.bluefinService.getPerpPosition(currentPrice),
      this.bluefinService.getFundingRate()
    ]);

    const deltaStatus = evaluateDeltaHedgeStatus(
      spotMetrics.spotDeltaSui,
      perpStatus.shortSizeSui,
      currentPrice,
      SUI_CONFIG.hedging.deltaDriftTolerancePct,
      SUI_CONFIG.hedging.rehedgeMinSuiAmount
    );

    let adjustmentResult = null;
    if (deltaStatus.requiresRehedge && executeOrders) {
      adjustmentResult = await this.bluefinService.executeHedgeAdjustment(
        deltaStatus.adjustmentAction,
        deltaStatus.adjustmentAmountSui,
        currentPrice
      );
    }

    const clmmAssetsUsd = spotMetrics.spotDeltaUsd + spotMetrics.usdcHeld;
    const perpEquityUsd = perpStatus.totalAccountValueUsd !== undefined
      ? perpStatus.totalAccountValueUsd
      : (perpStatus.marginAllocatedUsd + perpStatus.unrealizedPnlUsd + perpStatus.fundingAccruedUsd);
    const totalPortfolioValueUsd = clmmAssetsUsd + accruedFeesUsd + perpEquityUsd;

    let dynamicApr = grossApr !== undefined ? { grossApr } : null;
    if (!dynamicApr) {
      dynamicApr = await this.turbosService.getDynamicApr(
        SUI_CONFIG.strategy.targetBandWidthPct || 10,
        inRange
      );
    }

    const apyBreakdown = computeMarketNeutralApy(
      dynamicApr.grossApr,
      fundingInfo.rate8h,
      1.5
    );

    const report = {
      timestamp: new Date().toISOString(),
      currentPrice,
      spotMetrics,
      perpStatus,
      fundingInfo,
      deltaStatus,
      adjustmentResult,
      vaultBreakdown,
      portfolio: {
        clmmAssetsUsd: Math.round(clmmAssetsUsd * 100) / 100,
        clmmAccruedFeesUsd: Math.round(accruedFeesUsd * 100) / 100,
        perpEquityUsd: Math.round(perpEquityUsd * 100) / 100,
        totalPortfolioValueUsd: Math.round(totalPortfolioValueUsd * 100) / 100,
        netDeltaSui: deltaStatus.netDeltaSui,
        netDeltaUsd: deltaStatus.netDeltaUsd,
        deltaNeutralityHealth: Math.abs(deltaStatus.deltaDriftPct) <= SUI_CONFIG.hedging.deltaDriftTolerancePct ? 'BALANCED' : 'RE_HEDGED'
      },
      apyBreakdown,
      clmmApr: dynamicApr
    };

    this.history.push(report);
    if (this.history.length > 50) this.history.shift();

    return report;
  }
}
