// src/hedging/hedgingEngine.mjs
// Delta-Neutral Hedging Engine: Synchronizes Turbos CLMM & Bluefin Perps

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
    this.bluefinService = options.bluefinService || new BluefinService({
      initialShortSizeSui: options.initialShortSizeSui || 371.729
    });
    this.history = [];
  }

  /**
   * Evaluates the delta-neutral portfolio health and triggers hedge rebalancing if necessary.
   * 
   * @param {Object} clmmAnalysis Turbos position analysis
   * @param {number} simulatedPrice Optional price override for stress testing
   */
  async evaluateAndHedge(clmmAnalysis, simulatedPrice = null) {
    const currentPrice = simulatedPrice !== null ? simulatedPrice : clmmAnalysis.pool.currentPrice;
    const position = clmmAnalysis.position;

    // 1. Calculate Instantaneous CLMM Spot Delta
    const spotMetrics = calculateClmmSpotDelta(
      position.liquidity,
      currentPrice,
      clmmAnalysis.rangeMetrics.priceLower,
      clmmAnalysis.rangeMetrics.priceUpper
    );

    // 2. Query Current Bluefin Perp Position
    const perpStatus = await this.bluefinService.getPerpPosition(currentPrice);
    const fundingInfo = await this.bluefinService.getFundingRate();

    // 3. Evaluate Net Delta & Drift
    const deltaStatus = evaluateDeltaHedgeStatus(
      spotMetrics.spotDeltaSui,
      perpStatus.shortSizeSui,
      currentPrice,
      SUI_CONFIG.hedging.deltaDriftTolerancePct,
      SUI_CONFIG.hedging.rehedgeMinSuiAmount
    );

    // 4. Execute Dynamic Re-Hedging Adjustment if required
    let adjustmentResult = null;
    if (deltaStatus.requiresRehedge && SUI_CONFIG.hedging.enabled) {
      adjustmentResult = await this.bluefinService.executeHedgeAdjustment(
        deltaStatus.adjustmentAction,
        deltaStatus.adjustmentAmountSui,
        currentPrice
      );
    }

    // 5. Total Combined Portfolio Value & PnL Breakdown
    // CLMM Spot Assets: SUI Value + USDC Value + Accrued Fees
    const clmmAssetsUsd = spotMetrics.spotDeltaUsd + spotMetrics.usdcHeld;
    const clmmAccruedFeesUsd = clmmAnalysis.accruedFees.totalFeesUsd;
    
    // Perp Assets: Allocated Margin + Unrealized PnL + Accrued Funding
    const perpEquityUsd = perpStatus.marginAllocatedUsd + perpStatus.unrealizedPnlUsd + perpStatus.fundingAccruedUsd;
    
    // Total Combined Portfolio USD Value
    const totalPortfolioValueUsd = clmmAssetsUsd + clmmAccruedFeesUsd + perpEquityUsd;

    // APY Breakdown
    const apyBreakdown = computeMarketNeutralApy(
      105.0, // Baseline ~105% gross trading fee APR
      fundingInfo.rate8h,
      1.5 // ~1.5% annual churn cost for re-hedging
    );

    const report = {
      timestamp: new Date().toISOString(),
      currentPrice,
      spotMetrics,
      perpStatus,
      fundingInfo,
      deltaStatus,
      adjustmentResult,
      portfolio: {
        clmmAssetsUsd: Math.round(clmmAssetsUsd * 100) / 100,
        clmmAccruedFeesUsd: Math.round(clmmAccruedFeesUsd * 100) / 100,
        perpEquityUsd: Math.round(perpEquityUsd * 100) / 100,
        totalPortfolioValueUsd: Math.round(totalPortfolioValueUsd * 100) / 100,
        netDeltaSui: deltaStatus.netDeltaSui,
        netDeltaUsd: deltaStatus.netDeltaUsd,
        deltaNeutralityHealth: Math.abs(deltaStatus.deltaDriftPct) <= SUI_CONFIG.hedging.deltaDriftTolerancePct ? 'BALANCED' : 'RE_HEDGED'
      },
      apyBreakdown
    };

    this.history.push(report);
    if (this.history.length > 50) this.history.shift();

    return report;
  }
}

