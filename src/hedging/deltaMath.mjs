// src/hedging/deltaMath.mjs
// Mathematical Foundations for CLMM Delta-Neutral Hedging & Dynamic Re-centering

import BN from 'bn.js';
import { TurbosSdk, Network } from 'turbos-clmm-sdk';
import { SUI_CONFIG } from '../config.mjs';

const turbosSdk = new TurbosSdk(Network[SUI_CONFIG.network] || Network.mainnet);

/**
 * Calculates instantaneous spot SUI delta from a CLMM position.
 * In a CLMM, instantaneous delta dV/dP in units of Coin A is mathematically equal to the
 * exact amount of Coin A held in the position.
 * 
 * @param {string|number} liquidity Position liquidity units
 * @param {number} currentPrice Current spot price (e.g. 2.05 USDC per SUI)
 * @param {number} priceLower Lower boundary price (e.g. 1.80 USDC)
 * @param {number} priceUpper Upper boundary price (e.g. 2.21 USDC)
 * @returns {Object} { spotDeltaSui, spotDeltaUsd, usdcHeld, totalValueUsd }
 */
export function calculateClmmSpotDelta(liquidity, currentPrice, priceLower, priceUpper) {
  const currentSqrtPrice = turbosSdk.math.priceToSqrtPriceX64(
    currentPrice,
    SUI_CONFIG.decimals.SUI,
    SUI_CONFIG.decimals.USDC
  );
  const lowerSqrtPrice = turbosSdk.math.priceToSqrtPriceX64(
    priceLower,
    SUI_CONFIG.decimals.SUI,
    SUI_CONFIG.decimals.USDC
  );
  const upperSqrtPrice = turbosSdk.math.priceToSqrtPriceX64(
    priceUpper,
    SUI_CONFIG.decimals.SUI,
    SUI_CONFIG.decimals.USDC
  );

  const [amountA, amountB] = turbosSdk.pool.getTokenAmountsFromLiquidity({
    currentSqrtPrice,
    lowerSqrtPrice,
    upperSqrtPrice,
    liquidity: new BN(liquidity.toString())
  });

  const spotDeltaSui = amountA.toNumber() / (10 ** SUI_CONFIG.decimals.SUI);
  const usdcHeld = amountB.toNumber() / (10 ** SUI_CONFIG.decimals.USDC);
  const spotDeltaUsd = spotDeltaSui * currentPrice;
  const totalValueUsd = spotDeltaUsd + usdcHeld;

  return {
    spotDeltaSui,
    spotDeltaUsd,
    usdcHeld,
    totalValueUsd
  };
}

/**
 * Evaluates net portfolio delta and checks whether a re-hedge order is required.
 * 
 * @param {number} spotDeltaSui Current SUI held in CLMM position
 * @param {number} perpShortSizeSui Current Short position size on Bluefin (positive number representing short size)
 * @param {number} currentPrice Spot price
 * @param {number} tolerancePct Drift tolerance percentage (e.g. 5.0%)
 * @param {number} minOrderSizeSui Minimum trade size to justify execution costs
 */
export function evaluateDeltaHedgeStatus(
  spotDeltaSui,
  perpShortSizeSui,
  currentPrice,
  tolerancePct = SUI_CONFIG.hedging.deltaDriftTolerancePct,
  minOrderSizeSui = SUI_CONFIG.hedging.rehedgeMinSuiAmount
) {
  // Net Delta in SUI: Delta_net = Delta_spot - Short_size
  const netDeltaSui = spotDeltaSui - perpShortSizeSui;
  const netDeltaUsd = netDeltaSui * currentPrice;

  // Drift percentage relative to spot delta
  const baseDelta = Math.max(spotDeltaSui, 1);
  const deltaDriftPct = (Math.abs(netDeltaSui) / baseDelta) * 100;

  // Sizing adjustment needed to restore net delta = 0
  const requiredAdjustmentSui = spotDeltaSui - perpShortSizeSui;
  const isAdjustmentSignificant = Math.abs(requiredAdjustmentSui) >= minOrderSizeSui;
  const requiresRehedge = deltaDriftPct > tolerancePct && isAdjustmentSignificant;

  let adjustmentAction = 'NO_ACTION';
  if (requiresRehedge) {
    // If netDeltaSui > 0, spot SUI exceeds short size -> Increase Short
    // If netDeltaSui < 0, short size exceeds spot SUI -> Decrease Short (cover)
    adjustmentAction = requiredAdjustmentSui > 0 ? 'INCREASE_SHORT' : 'DECREASE_SHORT';
  }

  return {
    spotDeltaSui: Math.round(spotDeltaSui * 1000) / 1000,
    perpShortSizeSui: Math.round(perpShortSizeSui * 1000) / 1000,
    netDeltaSui: Math.round(netDeltaSui * 1000) / 1000,
    netDeltaUsd: Math.round(netDeltaUsd * 100) / 100,
    deltaDriftPct: Math.round(deltaDriftPct * 100) / 100,
    requiresRehedge,
    adjustmentAction,
    adjustmentAmountSui: Math.abs(Math.round(requiredAdjustmentSui * 1000) / 1000)
  };
}

/**
 * Calculates perpetual margin requirements and liquidation threshold.
 * 
 * @param {number} shortSizeSui 
 * @param {number} entryPrice 
 * @param {number} leverage e.g. 1.0 (1x)
 * @param {number} marginBufferPct e.g. 50 (50% extra cushion)
 */
export function calculatePerpMarginHealth(
  shortSizeSui,
  entryPrice,
  leverage = SUI_CONFIG.hedging.targetLeverage,
  marginBufferPct = 50
) {
  const notionalUsd = shortSizeSui * entryPrice;
  const initialMarginUsd = notionalUsd / leverage;
  const recommendedBufferUsd = initialMarginUsd * (marginBufferPct / 100);
  const totalMarginAllocatedUsd = initialMarginUsd + recommendedBufferUsd;

  // For a short position, liquidation occurs when price rises:
  // Margin Ratio = (Margin + Unrealized PnL) / Notional
  // Liquidation Price = EntryPrice * (1 + (TotalMargin / Notional) - MaintenanceMarginRatio)
  const maintenanceMarginRatio = 0.05; // 5% maintenance margin
  const liquidationPrice = entryPrice * (1 + (totalMarginAllocatedUsd / notionalUsd) - maintenanceMarginRatio);

  return {
    notionalUsd: Math.round(notionalUsd * 100) / 100,
    initialMarginUsd: Math.round(initialMarginUsd * 100) / 100,
    recommendedBufferUsd: Math.round(recommendedBufferUsd * 100) / 100,
    totalMarginAllocatedUsd: Math.round(totalMarginAllocatedUsd * 100) / 100,
    liquidationPrice: Math.round(liquidationPrice * 10000) / 10000,
    safetyMarginToLiqPct: Math.round(((liquidationPrice - entryPrice) / entryPrice) * 1000) / 10
  };
}

/**
 * Computes combined market-neutral portfolio returns and APY breakdown.
 * 
 * @param {number} lpFeeApr e.g. 100 (100% APR from trading fees)
 * @param {number} fundingRate8h e.g. 0.0001 (+0.01% per 8h)
 * @param {number} rehedgeChurnCostApr Estimated re-hedge slippage cost (e.g. 1.5%)
 */
export function computeMarketNeutralApy(lpFeeApr = 100.0, fundingRate8h = 0.0001, rehedgeChurnCostApr = 1.5) {
  // Annualize funding rate: 3 periods per day * 365 days = 1095 periods
  // If funding is positive (longs pay shorts), short position EARNS funding!
  const fundingApr = fundingRate8h * 1095 * 100;
  
  // Net annualized return:
  // Fee APR + Funding APR (or - Funding APR if negative) - Rehedge Churn
  const netAnnualizedApy = lpFeeApr + fundingApr - rehedgeChurnCostApr;

  return {
    clmmFeeApr: lpFeeApr,
    fundingApr8hPct: fundingRate8h * 100,
    annualizedFundingApr: Math.round(fundingApr * 10) / 10,
    rehedgeChurnCostApr,
    netMarketNeutralApy: Math.round(netAnnualizedApy * 10) / 10,
    isFundingYielding: fundingRate8h >= 0
  };
}

