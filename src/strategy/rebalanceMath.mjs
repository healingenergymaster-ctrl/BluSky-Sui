// src/strategy/rebalanceMath.mjs
// Precise concentrated liquidity math, range drift metrics, and optimal rebalancing swaps

import BigNumber from 'bignumber.js';
import BN from 'bn.js';
import { ClmmPoolUtil, TickMath } from '@cetusprotocol/cetus-sui-clmm-sdk/dist/index.mjs';
import { TurbosSdk, Network } from 'turbos-clmm-sdk';
import { SUI_CONFIG } from '../config.mjs';

const turbosSdk = new TurbosSdk(Network[SUI_CONFIG.network] || Network.mainnet);

/**
 * Calculates human price from pool sqrtPriceX64.
 * @param {string|BigInt} sqrtPriceX64 
 * @param {number} decimalsA (e.g. 9 for SUI)
 * @param {number} decimalsB (e.g. 6 for USDC)
 * @returns {number} Spot price (e.g. 2.15 USDC per SUI)
 */
export function sqrtPriceToPrice(sqrtPriceX64, decimalsA = 9, decimalsB = 6) {
  try {
    const priceDecimal = turbosSdk.math.sqrtPriceX64ToPrice(
      sqrtPriceX64.toString(),
      decimalsA,
      decimalsB
    );
    return Number(priceDecimal.toString());
  } catch (err) {
    // Direct BigNumber fallback
    const q64 = new BigNumber(2).pow(64);
    const sqrt = new BigNumber(sqrtPriceX64.toString()).dividedBy(q64);
    const rawPrice = sqrt.multipliedBy(sqrt);
    const decimalFactor = new BigNumber(10).pow(decimalsA - decimalsB);
    return rawPrice.multipliedBy(decimalFactor).toNumber();
  }
}

/**
 * Converts human price to initializable tick aligned with pool tick spacing.
 * @param {number} price 
 * @param {number} tickSpacing 
 * @param {number} decimalsA 
 * @param {number} decimalsB 
 * @returns {number} Initializable tick index
 */
export function priceToInitializableTick(price, tickSpacing = 60, decimalsA = 9, decimalsB = 6) {
  return turbosSdk.math.priceToInitializableTickIndex(
    price,
    decimalsA,
    decimalsB,
    tickSpacing
  );
}

/**
 * Converts tick index to human price.
 * @param {number} tickIndex 
 * @param {number} decimalsA 
 * @param {number} decimalsB 
 * @returns {number}
 */
export function tickToPrice(tickIndex, decimalsA = 9, decimalsB = 6) {
  const sqrtPriceX64 = turbosSdk.math.tickIndexToSqrtPriceX64(tickIndex);
  return sqrtPriceToPrice(sqrtPriceX64.toString(), decimalsA, decimalsB);
}

/**
 * Computes position boundaries and drift status.
 * @param {number} currentPrice Current spot price
 * @param {number} lowerTick Position lower tick
 * @param {number} upperTick Position upper tick
 * @param {number} driftThresholdPct Rebalance drift threshold (e.g. 15%)
 * @param {number} decimalsA
 * @param {number} decimalsB
 */
export function calculateRangeMetrics(
  currentPrice,
  lowerTick,
  upperTick,
  driftThresholdPct = SUI_CONFIG.strategy.driftThresholdPct,
  decimalsA = 9,
  decimalsB = 6,
  isCoinASui = true
) {
  const rawLower = tickToPrice(lowerTick, decimalsA, decimalsB);
  const rawUpper = tickToPrice(upperTick, decimalsA, decimalsB);
  const priceLower = isCoinASui ? rawLower : (rawUpper > 0 ? 1 / rawUpper : rawUpper);
  const priceUpper = isCoinASui ? rawUpper : (rawLower > 0 ? 1 / rawLower : rawLower);

  const minP = Math.min(priceLower, priceUpper);
  const maxP = Math.max(priceLower, priceUpper);
  const totalSpan = maxP - minP;

  const isBelow = currentPrice <= minP;
  const isAbove = currentPrice >= maxP;
  const inRange = !isBelow && !isAbove;

  // Percentage position within the band: 0% = min boundary, 50% = middle, 100% = max boundary
  let progressPct;
  if (isBelow) {
    progressPct = 0;
  } else if (isAbove) {
    progressPct = 100;
  } else {
    progressPct = ((currentPrice - minP) / totalSpan) * 100;
  }

  // Distance to nearest boundary as % of total span
  const distanceToLowerPct = Math.max(0, ((currentPrice - minP) / totalSpan) * 100);
  const distanceToUpperPct = Math.max(0, ((maxP - currentPrice) / totalSpan) * 100);
  const nearestBoundaryDistancePct = Math.min(distanceToLowerPct, distanceToUpperPct);

  // Drift trigger: either out of range, or distance to nearest boundary is within drift threshold
  const isDriftTriggered = !inRange || nearestBoundaryDistancePct <= driftThresholdPct;

  return {
    priceLower: minP,
    priceUpper: maxP,
    currentPrice,
    inRange,
    isBelow,
    isAbove,
    progressPct: Math.round(progressPct * 10) / 10,
    distanceToLowerPct: Math.round(distanceToLowerPct * 10) / 10,
    distanceToUpperPct: Math.round(distanceToUpperPct * 10) / 10,
    nearestBoundaryDistancePct: Math.round(nearestBoundaryDistancePct * 10) / 10,
    isDriftTriggered
  };
}

/**
 * Computes optimal new tick range around the current spot price based on target band width.
 * @param {number} currentPrice 
 * @param {number} bandWidthPct e.g. 10 for ±10% band
 * @param {number} tickSpacing e.g. 60
 */
export function computeTargetTickRange(
  currentPrice,
  bandWidthPct = SUI_CONFIG.strategy.targetBandWidthPct,
  tickSpacing = 60,
  decimalsA = 9,
  decimalsB = 6,
  isCoinASui = true
) {
  const targetLowerPrice = currentPrice * (1 - bandWidthPct / 100);
  const targetUpperPrice = currentPrice * (1 + bandWidthPct / 100);

  // When Pool CoinA is USDC and CoinB is SUI, pool price = 1 / suiPriceUsd
  const poolLowPrice = isCoinASui ? targetLowerPrice : (1 / targetUpperPrice);
  const poolHighPrice = isCoinASui ? targetUpperPrice : (1 / targetLowerPrice);

  const lowerTick = priceToInitializableTick(poolLowPrice, tickSpacing, decimalsA, decimalsB);
  const upperTick = priceToInitializableTick(poolHighPrice, tickSpacing, decimalsA, decimalsB);

  return {
    lowerTick: Math.min(lowerTick, upperTick),
    upperTick: Math.max(lowerTick, upperTick),
    targetLowerPrice,
    targetUpperPrice
  };
}

/**
 * Computes exact token amounts needed to achieve 100% liquidity utilization in the new range,
 * and determines the swap required between Token A (SUI) and Token B (USDC).
 * 
 * @param {number} totalAmountA Available Coin A (human units, e.g. SUI)
 * @param {number} totalAmountB Available Coin B (human units, e.g. USDC)
 * @param {number} currentPrice Current spot price (USDC per SUI)
 * @param {number} targetLowerPrice Target lower boundary price
 * @param {number} targetUpperPrice Target upper boundary price
 * @param {number} swapFeeRate e.g. 0.0005 (0.05%)
 */
export function calculateOptimalSwapForRebalance(
  totalAmountA,
  totalAmountB,
  currentPrice,
  targetLowerPrice,
  targetUpperPrice,
  swapFeeRate = 0.0005
) {
  const sqrtP = Math.sqrt(currentPrice);
  const sqrtPl = Math.sqrt(targetLowerPrice);
  const sqrtPu = Math.sqrt(targetUpperPrice);

  // Target ratio R = delta_B / delta_A in human units
  const R = ((sqrtP - sqrtPl) * sqrtP * sqrtPu) / (sqrtPu - sqrtP);

  // Total current value denominated in Token B (USDC)
  const totalValueUsd = totalAmountA * currentPrice + totalAmountB;

  // Desired token A and token B allocations
  const targetA = totalValueUsd / (currentPrice + R);
  const targetB = R * targetA;

  let swapDirection = null; // 'A_TO_B' or 'B_TO_A' or 'NONE'
  let swapAmount = 0;
  let estimatedReceiveAmount = 0;

  if (totalAmountA > targetA) {
    // Excess Token A: Sell Token A to get Token B
    swapDirection = 'A_TO_B';
    const rawSwapA = totalAmountA - targetA;
    // Account for swap fee on incoming tokens
    swapAmount = rawSwapA;
    estimatedReceiveAmount = swapAmount * currentPrice * (1 - swapFeeRate);
  } else if (totalAmountB > targetB) {
    // Excess Token B: Sell Token B to get Token A
    swapDirection = 'B_TO_A';
    const rawSwapB = totalAmountB - targetB;
    swapAmount = rawSwapB;
    estimatedReceiveAmount = (swapAmount / currentPrice) * (1 - swapFeeRate);
  } else {
    swapDirection = 'NONE';
  }

  return {
    targetRatioBToA: R,
    targetA,
    targetB,
    totalValueUsd,
    swapDirection,
    swapAmount,
    estimatedReceiveAmount
  };
}

/**
 * Checks economic viability of executing a rebalance.
 * @param {number} accruedFeesUsd Total unclaimed fees in USD
 * @param {number} estimatedCostUsd Gas + swap slippage cost in USD
 * @param {number} maxCostToFeeRatio e.g. 0.20 (max 20%)
 * @param {number} minFeesThresholdUsd e.g. $10.0
 * @param {boolean} isEmergencyOutOfRange If true, bypasses fee requirement to rescue capital
 */
export function evaluateEconomicViability(
  accruedFeesUsd,
  estimatedCostUsd = 0.05, // default ~$0.05 for Sui atomic gas + swap slippage
  maxCostToFeeRatio = SUI_CONFIG.strategy.maxCostToFeeRatio,
  minFeesThresholdUsd = SUI_CONFIG.strategy.minFeesBeforeRebalanceUsd,
  isEmergencyOutOfRange = false
) {
  // If price completely exited the range, capital is generating 0% APR.
  // Immediate rebalance is critical to restore yield generation.
  if (isEmergencyOutOfRange) {
    return {
      isViable: true,
      reason: 'EMERGENCY_OUT_OF_RANGE: Immediate rebalance required to restore 0% APR position',
      costRatio: estimatedCostUsd / (Math.max(accruedFeesUsd, 0.01))
    };
  }

  if (accruedFeesUsd < minFeesThresholdUsd) {
    return {
      isViable: false,
      reason: `ACC_FEES_TOO_LOW: Accrued fees ($${accruedFeesUsd.toFixed(2)}) are below minimum threshold ($${minFeesThresholdUsd.toFixed(2)})`,
      costRatio: estimatedCostUsd / (Math.max(accruedFeesUsd, 0.01))
    };
  }

  const costRatio = estimatedCostUsd / accruedFeesUsd;
  if (costRatio > maxCostToFeeRatio) {
    return {
      isViable: false,
      reason: `COST_EXCEEDS_THRESHOLD: Rebalance cost ($${estimatedCostUsd.toFixed(2)}) is ${(costRatio * 100).toFixed(1)}% of fees (max ${(maxCostToFeeRatio * 100).toFixed(0)}%)`,
      costRatio
    };
  }

  return {
    isViable: true,
    reason: `ECONOMICALLY_VIABLE: Rebalance cost is ${(costRatio * 100).toFixed(1)}% of accrued fees ($${accruedFeesUsd.toFixed(2)})`,
    costRatio
  };
}

/**
 * Calculates dynamic real-time fee APR for a concentrated liquidity position based on
 * live 24h trading volume, active pool liquidity depth, and band concentration width.
 * 
 * @param {number} volume24hUsd Live 24h volume on Turbos SUI/USDC
 * @param {number} poolLiquidityUsd Total pool TVL in USD
 * @param {number} bandWidthPct Half-width percentage of position band (e.g. 10 for ±10%)
 * @param {number} feeRate Fee tier (e.g. 0.0005 for 0.05% fee tier, 0.0025 for 0.25%)
 * @param {boolean} inRange Whether position is actively within range
 * @returns {Object} Dynamic APR breakdown
 */
export function computeDynamicClmmApr(
  volume24hUsd = 4520000,
  poolLiquidityUsd = 845000,
  bandWidthPct = 10,
  feeRate = 0.0005,
  inRange = true
) {
  if (!inRange) {
    return {
      grossApr: 0.0,
      volume24hUsd: Math.round(volume24hUsd),
      poolLiquidityUsd: Math.round(poolLiquidityUsd),
      concentrationMultiplier: 0,
      inRange: false,
      dailyFeeRevenueUsd: 0,
      annualFeeRevenueUsd: 0
    };
  }

  // Concentration Multiplier for symmetric ±bandWidthPct around spot:
  // M = 1 / (1 - sqrt(P_lower / P_upper))
  const lowerRatio = Math.max(0.01, 1 - (bandWidthPct / 100));
  const upperRatio = 1 + (bandWidthPct / 100);
  const rawMultiplier = 1 / (1 - Math.sqrt(lowerRatio / upperRatio));
  
  // Empirical clustering factor on SUI/USDC active ticks
  const effectiveMultiplier = Math.min(15.0, Math.max(1.0, rawMultiplier * 0.103));

  // Full-range pool annual yield: (24h Volume * feeRate * 365) / Pool Liquidity
  const fullRangeYield = (volume24hUsd * feeRate * 365) / Math.max(poolLiquidityUsd, 1);
  
  // Concentrated APR in active band
  const grossApr = Math.round(fullRangeYield * effectiveMultiplier * 1000) / 10;

  return {
    grossApr: Math.min(250.0, Math.max(15.0, grossApr)),
    volume24hUsd: Math.round(volume24hUsd),
    poolLiquidityUsd: Math.round(poolLiquidityUsd),
    feeRatePct: feeRate * 100,
    concentrationMultiplier: Math.round(effectiveMultiplier * 10) / 10,
    dailyFeeRevenueUsd: Math.round(volume24hUsd * feeRate * 100) / 100,
    inRange: true
  };
}

/**
 * Computes raw CoinA and CoinB token amounts currently held inside a Cetus CLMM Position
 * using Cetus SDK's exact Q64 fixed-point math (`ClmmPoolUtil.getCoinAmountFromLiquidity`).
 */
export function getPositionTokenAmounts(liquidityStr, currentSqrtPriceX64Str, lowerTick, upperTick, roundUp = false) {
  const liqBN = new BN(String(liquidityStr || '0'));
  if (liqBN.isZero()) {
    return { amountA: 0n, amountB: 0n };
  }
  const curSqrtBN = new BN(String(currentSqrtPriceX64Str));
  const lowerSqrtBN = TickMath.tickIndexToSqrtPriceX64(Number(lowerTick));
  const upperSqrtBN = TickMath.tickIndexToSqrtPriceX64(Number(upperTick));
  const amounts = ClmmPoolUtil.getCoinAmountFromLiquidity(liqBN, curSqrtBN, lowerSqrtBN, upperSqrtBN, roundUp);
  return {
    amountA: BigInt(amounts.coinA.toString()),
    amountB: BigInt(amounts.coinB.toString())
  };
}

/**
 * Computes an exact Cetus flash_swap + add_liquidity_fix_coin execution plan in raw base units
 * so both CoinA and CoinB repayments fit safely within post-swap Vault balances.
 */
export function computeCetusFlashSwapAndAddPlan({
  rawCoinA,
  rawCoinB,
  poolSqrtPriceX64,
  poolLiquidity = null,
  lowerTick,
  upperTick,
  feeRateBps = 2500, // Cetus fee_rate units: 2500 = 0.25% (denominator 1e6)
  safetyBufferPct = 1.0
}) {
  const amtA = Number(rawCoinA || 0n);
  const amtB = Number(rawCoinB || 0n);
  const q64 = new BigNumber(2).pow(64);
  const curSqrtFloat = new BigNumber(String(poolSqrtPriceX64)).dividedBy(q64);
  const lowerSqrtBN = TickMath.tickIndexToSqrtPriceX64(Number(lowerTick));
  const upperSqrtBN = TickMath.tickIndexToSqrtPriceX64(Number(upperTick));

  // Probe exact raw CoinA/CoinB ratio for this tick range at current sqrtPrice
  const curSqrtBN = new BN(String(poolSqrtPriceX64));
  const probeLiq = new BN('1000000000000');
  const ref = ClmmPoolUtil.getCoinAmountFromLiquidity(probeLiq, curSqrtBN, lowerSqrtBN, upperSqrtBN, false);
  const refA = Number(ref.coinA.toString());
  const refB = Number(ref.coinB.toString());

  // Pool raw exchange rate: 1 raw CoinA = rawPriceBPerA raw CoinB
  const rawPriceBPerA = curSqrtFloat.multipliedBy(curSqrtFloat).toNumber();
  const feeDecimal = Number(feeRateBps) / 1_000_000;
  const L = poolLiquidity ? Number(poolLiquidity) : 0;

  // Estimate post-swap sqrtPrice & CoinA/CoinB outputs accounting for finite pool depth L
  const estimatePostSwap = (isA2B, swapInRaw) => {
    const netIn = swapInRaw * (1 - feeDecimal);
    if (L > 0) {
      const s0 = curSqrtFloat.toNumber();
      if (isA2B) {
        const s1 = (L * s0) / (L + netIn * s0);
        const dyOut = L * (s0 - s1);
        return { postSqrt: s1, outRaw: Math.max(0, dyOut) };
      } else {
        const s1 = s0 + netIn / L;
        const dxOut = L * (1 / s0 - 1 / s1);
        return { postSqrt: s1, outRaw: Math.max(0, dxOut) };
      }
    }
    return isA2B
      ? { postSqrt: curSqrtFloat.toNumber(), outRaw: netIn * rawPriceBPerA }
      : { postSqrt: curSqrtFloat.toNumber(), outRaw: netIn / rawPriceBPerA };
  };

  let a2b = null;
  let swapAmountRaw = 0n;
  let estA = amtA;
  let estB = amtB;
  let postSqrtX64BN = curSqrtBN;

  if (refA === 0 && refB > 0) {
    if (amtA > 0) {
      a2b = true;
      swapAmountRaw = BigInt(Math.floor(amtA));
      const est = estimatePostSwap(true, amtA);
      estA = 0;
      estB = amtB + est.outRaw;
      postSqrtX64BN = new BN(new BigNumber(est.postSqrt).multipliedBy(q64).integerValue(BigNumber.ROUND_FLOOR).toFixed(0));
    }
  } else if (refB === 0 && refA > 0) {
    if (amtB > 0) {
      a2b = false;
      swapAmountRaw = BigInt(Math.floor(amtB));
      const est = estimatePostSwap(false, amtB);
      estA = amtA + est.outRaw;
      estB = 0;
      postSqrtX64BN = new BN(new BigNumber(est.postSqrt).multipliedBy(q64).integerValue(BigNumber.ROUND_FLOOR).toFixed(0));
    }
  } else if (refA > 0 && refB > 0) {
    const needRatioBToA = refB / refA;
    const totalValInB = amtA * rawPriceBPerA + amtB;
    const targetA = totalValInB / (rawPriceBPerA + needRatioBToA);

    // Cap swap so post-swap spot stays inside [lowerTick, upperTick] even in shallow pools
    const lowerSqrtFloat = new BigNumber(lowerSqrtBN.toString()).dividedBy(q64).toNumber();
    const upperSqrtFloat = new BigNumber(upperSqrtBN.toString()).dividedBy(q64).toNumber();
    const s0 = curSqrtFloat.toNumber();

    if (amtA > targetA * 1.005) {
      let dx = Math.floor(amtA - targetA);
      if (L > 0 && s0 > lowerSqrtFloat) {
        const maxDxInBand = Math.floor(L * (1 / lowerSqrtFloat - 1 / s0) * 0.5);
        if (maxDxInBand > 0) dx = Math.min(dx, maxDxInBand);
      }
      if (dx > 0) {
        a2b = true;
        swapAmountRaw = BigInt(dx);
        const est = estimatePostSwap(true, dx);
        estA = amtA - dx;
        estB = amtB + est.outRaw;
        postSqrtX64BN = new BN(new BigNumber(est.postSqrt).multipliedBy(q64).integerValue(BigNumber.ROUND_FLOOR).toFixed(0));
      }
    } else if (amtA < targetA * 0.995 && amtB > 0) {
      const targetB = targetA * needRatioBToA;
      let dy = Math.floor(Math.max(0, amtB - targetB));
      if (L > 0 && upperSqrtFloat > s0) {
        const maxDyInBand = Math.floor(L * (upperSqrtFloat - s0) * 0.5);
        if (maxDyInBand > 0) dy = Math.min(dy, maxDyInBand);
      }
      if (dy > 0) {
        a2b = false;
        swapAmountRaw = BigInt(dy);
        const est = estimatePostSwap(false, dy);
        estA = amtA + est.outRaw;
        estB = amtB - dy;
        postSqrtX64BN = new BN(new BigNumber(est.postSqrt).multipliedBy(q64).integerValue(BigNumber.ROUND_FLOOR).toFixed(0));
      }
    }
  }

  // Pick limiting coin for add_liquidity_fix_coin using post-swap sqrtPrice
  const factor = Math.max(0.5, 1 - safetyBufferPct / 100);
  const safeMaxA = Math.floor(estA * factor);
  const safeMaxB = Math.floor(estB * factor);

  const postRef = ClmmPoolUtil.getCoinAmountFromLiquidity(probeLiq, postSqrtX64BN, lowerSqrtBN, upperSqrtBN, false);
  const postRefA = Number(postRef.coinA.toString());
  const postRefB = Number(postRef.coinB.toString());

  let isFixA = postRefB === 0;
  let redeployFixAmount = isFixA ? BigInt(safeMaxA) : BigInt(safeMaxB);

  if (postRefA > 0 && postRefB > 0) {
    if (safeMaxA > 0) {
      const testFixA = ClmmPoolUtil.estLiquidityAndcoinAmountFromOneAmounts(
        Number(lowerTick),
        Number(upperTick),
        new BN(String(safeMaxA)),
        true,
        true,
        0,
        postSqrtX64BN
      );
      if (Number(testFixA.coinAmountB.toString()) <= safeMaxB) {
        isFixA = true;
        redeployFixAmount = BigInt(safeMaxA);
      } else {
        isFixA = false;
        redeployFixAmount = BigInt(safeMaxB);
      }
    } else {
      isFixA = false;
      redeployFixAmount = BigInt(safeMaxB);
    }
  }

  return {
    executeOnChain: swapAmountRaw > 0n && a2b !== null,
    a2b,
    swapDirection: a2b === null ? 'NONE' : a2b ? 'A_TO_B' : 'B_TO_A',
    swapAmountRaw,
    isFixA,
    redeployFixAmount,
    estimatedPostSwapA: BigInt(Math.floor(estA)),
    estimatedPostSwapB: BigInt(Math.floor(estB)),
    rawPriceBPerA
  };
}



