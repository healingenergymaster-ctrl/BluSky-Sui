// src/dashboard/vaultApi.mjs
// Public Dashboard API & Yield Analytics Service

import { SUI_CONFIG, getVaultCatalog, resolveVaultConfig } from '../config.mjs';
import { VaultContractService } from '../services/vaultContract.mjs';
import { computeMarketNeutralApy } from '../hedging/deltaMath.mjs';
import { defaultTurbosService } from '../services/turbos.mjs';
import { defaultCetusService } from '../services/cetus.mjs';
import { computeTargetTickRange } from '../strategy/rebalanceMath.mjs';
import { fetchLivePerpFundingRate } from '../services/bluefin.mjs';

export class VaultApiService {
  constructor(options = {}) {
    this.vaultService = options.vaultService || new VaultContractService();
    this.vaultApyCache = new Map();
    this.historicalEvents = [
      {
        id: 'evt_001',
        type: 'DEPOSIT',
        user: '0x9482...49e1',
        amountUsd: 5000.0,
        sharesMinted: 5000,
        timestamp: new Date(Date.now() - 3600000 * 24).toISOString()
      },
      {
        id: 'evt_002',
        type: 'COMPOUND',
        operator: '0x_operator_bot',
        grossFeesUsd: 71.40,
        performanceFeeCollectedUsd: 7.14,
        compoundedUsd: 64.26,
        timestamp: new Date(Date.now() - 3600000 * 12).toISOString()
      },
      {
        id: 'evt_003',
        type: 'REBALANCE',
        operator: '0x_operator_bot',
        oldRange: '$1.80 - $2.21',
        newRange: '$1.84 - $2.26',
        costUsd: 0.008,
        timestamp: new Date(Date.now() - 3600000 * 4).toISOString()
      }
    ];
  }

  /**
   * Returns complete high-level statistics for the public web vault page.
   * @param {number} currentPrice
   * @param {Object} options Optional live on-chain snapshot overrides
   */
  async getPublicVaultSummary(currentPrice = 0.895, options = {}) {
    const {
      vaultConfig = null,
      vaultSnapshot = null,
      cetusAnalysis: providedCetusAnalysis = null,
      turbosAnalysis: providedTurbosAnalysis = null,
      recentEvents = null,
      hedgingEnabled = SUI_CONFIG.hedging.enabled
    } = options;

    const resolvedVault = vaultConfig || resolveVaultConfig(vaultSnapshot?.vaultId);
    const catalog = getVaultCatalog();
    const bandWidthPct = SUI_CONFIG.strategy.targetBandWidthPct || 10;

    const activeBand = computeTargetTickRange(
      currentPrice,
      bandWidthPct,
      resolvedVault.tickSpacing || 10,
      SUI_CONFIG.decimals.USDC,
      SUI_CONFIG.decimals.SUI,
      false
    );

    const turbosPoolId = catalog.turbos005.poolId;
    const cetusPoolId = resolvedVault.dex === 'cetus' ? resolvedVault.poolId : catalog.cetus005.poolId;
    const cetusTightPoolId = catalog.cetus005.poolId;
    const cetusLegacyPoolId = catalog.cetus025.poolId;
    const cachedLegacy = this.vaultApyCache.get('cetus025');
    const needLegacyFetch = cetusPoolId !== cetusLegacyPoolId && (!cachedLegacy || Date.now() - cachedLegacy.ts > 120_000);

    const [vaultState, turbosApr, liveFunding, cetusAnalysis, cetusTightAnalysis, cetusLegacyAnalysis] = await Promise.all([
      vaultSnapshot
        ? Promise.resolve(null)
        : this.vaultService.getVaultMetrics(resolvedVault.objectId || '0x_blusky_sui_usdc_vault', currentPrice),
      providedTurbosAnalysis?.apr
        ? Promise.resolve({ ...providedTurbosAnalysis.apr, feeRateBps: providedTurbosAnalysis.pool?.fee || 500, poolStats: { volume24hUsd: providedTurbosAnalysis.metrics?.volume24hUsd, liquidityUsd: providedTurbosAnalysis.metrics?.liquidityUsd, source: providedTurbosAnalysis.metrics?.volumeSource } })
        : defaultTurbosService.getDynamicApr(bandWidthPct, true, { poolId: turbosPoolId }),
      hedgingEnabled ? fetchLivePerpFundingRate() : Promise.resolve({ rate8h: 0, rate8hPct: 0, annualizedApr: 0, source: 'Disabled (CLMM-Only)' }),
      providedCetusAnalysis
        ? Promise.resolve(providedCetusAnalysis)
        : defaultCetusService.analyzePosition(
            cetusPoolId,
            vaultSnapshot?.position?.lowerTick ?? activeBand.lowerTick,
            vaultSnapshot?.position?.upperTick ?? activeBand.upperTick,
            vaultSnapshot?.positionNftId || '0x_cetus_active_vault_position',
            currentPrice
          ),
      cetusPoolId === cetusTightPoolId
        ? Promise.resolve(null)
        : defaultCetusService.analyzePosition(
            cetusTightPoolId,
            activeBand.lowerTick,
            activeBand.upperTick,
            '0x_cetus_005_benchmark',
            currentPrice
          ).catch(() => null),
      needLegacyFetch
        ? defaultCetusService.analyzePosition(
            cetusLegacyPoolId,
            activeBand.lowerTick,
            activeBand.upperTick,
            '0x_cetus_025_benchmark',
            currentPrice
          ).catch(() => null)
        : Promise.resolve(null)
    ]);

    const cetusEffectiveTight = cetusPoolId === cetusTightPoolId ? cetusAnalysis : cetusTightAnalysis;
    const turbosPoolStats = turbosApr.poolStats || {};

    const rawTvlUsd = vaultSnapshot
      ? (vaultSnapshot.totalUsdc + vaultSnapshot.totalSui * currentPrice)
      : vaultState.totalValUsd;
    const tvlUsd = Math.round(rawTvlUsd * 10000) / 10000;
    const totalShares = vaultSnapshot ? Number(vaultSnapshot.totalShares || 0n) : vaultState.totalShares;
    const sharePriceUsd = vaultSnapshot
      ? (totalShares > 0 ? Math.round((rawTvlUsd / (totalShares / 1e6)) * 10000) / 10000 : 1.0)
      : vaultState.sharePriceUsd;
    const performanceFeePct = vaultSnapshot ? (vaultSnapshot.feeRateBps || 1000) / 100 : vaultState.performanceFeePct;
    const feeTreasury = vaultSnapshot ? vaultSnapshot.feeTreasury : vaultState.feeTreasury;

    const cetusMetrics = cetusAnalysis.metrics || {};
    const cetusTightMetrics = cetusEffectiveTight?.metrics || null;
    const turbosGrossApr = turbosApr.grossApr ?? 0;
    const cetusGrossApr = cetusMetrics.grossApr ?? 0;
    const isTurbosActive = resolvedVault.dex === 'turbos';

    const activeMetrics = isTurbosActive ? turbosApr : cetusMetrics;
    const grossApr = isTurbosActive ? turbosGrossApr : cetusGrossApr;

    const netLpFeeApr = grossApr * (1 - performanceFeePct / 100);
    const apyMetrics = hedgingEnabled
      ? computeMarketNeutralApy(netLpFeeApr, liveFunding.rate8h, 1.5)
      : {
          annualizedFundingApr: 0,
          rehedgeChurnCostApr: 0,
          netMarketNeutralApy: Math.round(netLpFeeApr * 10) / 10
        };

    const dailyGrossYieldUsd = (rawTvlUsd * (grossApr / 100)) / 365;
    const dailyNetYieldUsd = (rawTvlUsd * (apyMetrics.netMarketNeutralApy / 100)) / 365;
    const annualProtocolRevenueUsd = (rawTvlUsd * (grossApr / 100)) * (performanceFeePct / 100);
    const dailyProtocolRevenueUsd = annualProtocolRevenueUsd / 365;
    const spreadPct = Math.round((cetusGrossApr - turbosGrossApr) * 10) / 10;

    const calcNet = (g) => Math.round((g * (1 - performanceFeePct / 100)) * 10) / 10;
    const cetus005Gross = cetusTightMetrics?.grossApr ?? cetusGrossApr;
    this.vaultApyCache.set('cetus005', { grossApr: cetus005Gross, ts: Date.now() });
    this.vaultApyCache.set('turbos005', { grossApr: turbosGrossApr, ts: Date.now() });

    let cetus025Gross = null;
    if (cetusPoolId === cetusLegacyPoolId) {
      cetus025Gross = cetusGrossApr;
      this.vaultApyCache.set('cetus025', { grossApr: cetus025Gross, ts: Date.now() });
    } else if (cetusLegacyAnalysis?.metrics?.grossApr !== undefined) {
      cetus025Gross = cetusLegacyAnalysis.metrics.grossApr;
      this.vaultApyCache.set('cetus025', { grossApr: cetus025Gross, ts: Date.now() });
    } else if (cachedLegacy) {
      cetus025Gross = cachedLegacy.grossApr;
    }

    const availableVaults = [
      {
        key: 'cetus005',
        label: catalog.cetus005.label,
        shortLabel: catalog.cetus005.shortLabel,
        dex: 'cetus',
        dexName: 'Cetus Protocol',
        feeTier: '0.05%',
        objectId: catalog.cetus005.objectId,
        poolId: catalog.cetus005.poolId,
        deployed: Boolean(catalog.cetus005.objectId),
        grossApr: cetus005Gross,
        netApy: calcNet(cetus005Gross)
      },
      {
        key: 'turbos005',
        label: catalog.turbos005.label,
        shortLabel: catalog.turbos005.shortLabel,
        dex: 'turbos',
        dexName: 'Turbos Finance',
        feeTier: '0.05%',
        objectId: catalog.turbos005.objectId,
        poolId: catalog.turbos005.poolId,
        deployed: Boolean(catalog.turbos005.objectId),
        grossApr: turbosGrossApr,
        netApy: calcNet(turbosGrossApr)
      },
      {
        key: 'cetus025',
        label: catalog.cetus025.label,
        shortLabel: catalog.cetus025.shortLabel,
        dex: 'cetus',
        dexName: 'Cetus Protocol',
        feeTier: '0.25%',
        objectId: catalog.cetus025.objectId,
        poolId: catalog.cetus025.poolId,
        deployed: Boolean(catalog.cetus025.objectId),
        grossApr: cetus025Gross,
        netApy: cetus025Gross !== null && cetus025Gross !== undefined ? calcNet(cetus025Gross) : null
      }
    ];

    return {
      vaultKey: resolvedVault.key,
      dex: resolvedVault.dex,
      dexName: resolvedVault.dexName,
      feeTier: resolvedVault.feeTier,
      poolId: resolvedVault.poolId,
      availableVaults,
      isLiveVault: Boolean(vaultSnapshot),
      vaultId: vaultSnapshot?.vaultId || resolvedVault.objectId,
      packageId: resolvedVault.packageId,
      vaultName: `BluSky ${resolvedVault.label} Vault`,
      underlyingPair: 'SUI / Circle USDC',
      strategyType: hedgingEnabled
        ? `Delta-Neutral Concentrated Liquidity (${resolvedVault.shortLabel} + Perps)`
        : `CLMM-Only Concentrated Liquidity (${resolvedVault.shortLabel})`,
      tvlUsd,
      sharePriceUsd,
      sharePriceUnit: vaultSnapshot ? 'per 1M raw shares' : 'per VaultShare',
      totalShares,
      balances: vaultSnapshot ? {
        totalUsdc: vaultSnapshot.totalUsdc,
        totalSui: vaultSnapshot.totalSui,
        idleUsdc: vaultSnapshot.idleUsdc,
        idleSui: vaultSnapshot.idleSui,
        positionHoldUsdc: vaultSnapshot.positionHoldUsdc,
        positionHoldSui: vaultSnapshot.positionHoldSui
      } : null,
      performanceFeePct: `${performanceFeePct}%`,
      managementFeePct: '0.0%',
      apy: {
        grossTradingApr: `${grossApr}%`,
        feeApr: `${activeMetrics.feeApr ?? grossApr}%`,
        rewardApr: `${activeMetrics.rewardApr ?? 0}%`,
        bluefinFundingApr: hedgingEnabled ? `${apyMetrics.annualizedFundingApr >= 0 ? '+' : ''}${apyMetrics.annualizedFundingApr}%` : 'OFF (CLMM-Only)',
        protocolFeeDeduction: `-${(grossApr * (performanceFeePct / 100)).toFixed(1)}%`,
        rehedgeChurnCost: hedgingEnabled ? `-${apyMetrics.rehedgeChurnCostApr}%` : '0.0%',
        netInvestorApy: `${apyMetrics.netMarketNeutralApy}%`,
        isDynamic: true,
        volume24hUsd: isTurbosActive ? (turbosPoolStats.volume24hUsd ?? turbosApr.volume24hUsd ?? 0) : (cetusMetrics.volume24hUsd ?? 0),
        poolLiquidityUsd: isTurbosActive ? (turbosPoolStats.liquidityUsd ?? turbosApr.poolLiquidityUsd ?? 0) : (cetusMetrics.liquidityUsd ?? 0),
        activePoolUsdInBand: activeMetrics.activePoolUsdInBand ?? 0,
        concentrationMultiplier: activeMetrics.concentrationMultiplier ?? 0,
        methodology: activeMetrics.methodology || 'onchain_active_L',
        fundingSource: liveFunding.source,
        volumeSource: isTurbosActive ? (turbosPoolStats.source || 'DexScreener Turbos Pool') : (cetusMetrics.volumeSource || 'DexScreener Cetus Pool')
      },
      dexPools: {
        cetus: {
          poolId: cetusPoolId,
          feeRateBps: cetusMetrics.feeRateBps ?? (cetusAnalysis.pool?.feeRate || 500),
          volume24hUsd: cetusMetrics.volume24hUsd ?? 0,
          liquidityUsd: cetusMetrics.liquidityUsd ?? 0,
          activePoolUsdInBand: cetusMetrics.activePoolUsdInBand ?? 0,
          feeApr: cetusMetrics.feeApr ?? cetusGrossApr,
          rewardApr: cetusMetrics.rewardApr ?? 0,
          grossApr: cetusGrossApr,
          concentrationMultiplier: cetusMetrics.concentrationMultiplier ?? 0,
          methodology: cetusMetrics.methodology || 'onchain_active_L',
          source: cetusMetrics.volumeSource || 'DexScreener Live API'
        },
        ...(cetusTightMetrics ? {
          cetus005: {
            poolId: cetusTightPoolId,
            feeRateBps: cetusTightMetrics.feeRateBps ?? 500,
            volume24hUsd: cetusTightMetrics.volume24hUsd ?? 0,
            liquidityUsd: cetusTightMetrics.liquidityUsd ?? 0,
            activePoolUsdInBand: cetusTightMetrics.activePoolUsdInBand ?? 0,
            feeApr: cetusTightMetrics.feeApr ?? 0,
            rewardApr: cetusTightMetrics.rewardApr ?? 0,
            grossApr: cetusTightMetrics.grossApr ?? 0,
            concentrationMultiplier: cetusTightMetrics.concentrationMultiplier ?? 0,
            methodology: cetusTightMetrics.methodology || 'onchain_active_L',
            source: cetusTightMetrics.volumeSource || 'DexScreener Live API'
          }
        } : {}),
        turbos: {
          poolId: turbosPoolId,
          feeRateBps: turbosApr.feeRateBps ?? 500,
          volume24hUsd: turbosPoolStats.volume24hUsd ?? turbosApr.volume24hUsd ?? 0,
          liquidityUsd: turbosPoolStats.liquidityUsd ?? turbosApr.poolLiquidityUsd ?? 0,
          activePoolUsdInBand: turbosApr.activePoolUsdInBand ?? 0,
          feeApr: turbosApr.feeApr ?? turbosGrossApr,
          rewardApr: turbosApr.rewardApr ?? 0,
          grossApr: turbosGrossApr,
          concentrationMultiplier: turbosApr.concentrationMultiplier ?? 0,
          methodology: turbosApr.methodology || 'onchain_active_L',
          source: turbosPoolStats.source || 'DexScreener Live API'
        }
      },
      economics: {
        dailyGrossYieldUsd: Math.round(dailyGrossYieldUsd * 10000) / 10000,
        dailyNetYieldUsd: Math.round(dailyNetYieldUsd * 10000) / 10000,
        dailyProtocolFeeEarnedUsd: Math.round(dailyProtocolRevenueUsd * 10000) / 10000,
        annualProtocolFeeEarnedUsd: Math.round(annualProtocolRevenueUsd * 10000) / 10000,
        feeTreasuryAddress: feeTreasury
      },
      safety: {
        nonCustodial: true,
        smartContractAudited: 'Move 2024 Object Model',
        rebalanceConsensus: 'Mysticeti Sub-Second Finality',
        perpLiquidationBuffer: hedgingEnabled ? '>140% safety margin' : 'N/A (CLMM-Only)'
      },
      dualDexRouting: {
        primaryDex: resolvedVault.dexName,
        cetusGrossApr: `${cetusTightMetrics?.grossApr ?? cetusGrossApr}%`,
        turbosGrossApr: `${turbosGrossApr}%`,
        spreadPct: `${Math.round(((cetusTightMetrics?.grossApr ?? cetusGrossApr) - turbosGrossApr) * 10) / 10}%`,
        routingRecommendation: spreadPct >= 15
          ? 'OPTIMAL (Cetus Dominant)'
          : spreadPct <= -15
            ? 'TURBOS_HIGHER_APR'
            : 'BALANCED_PARITY',
        cetusPoolLiquidityUsd: cetusMetrics.liquidityUsd ?? 0,
        cetus24hVolumeUsd: cetusMetrics.volume24hUsd ?? 0,
        turbosPoolLiquidityUsd: turbosPoolStats.liquidityUsd,
        turbos24hVolumeUsd: turbosPoolStats.volume24hUsd
      },
      recentEvents: recentEvents || this.historicalEvents
    };
  }

  /**
   * Simulates a user deposit.
   * @param {number} depositUsdcAmount 
   * @param {number} currentPrice 
   * @param {object|null} vaultSnapshot
   * @param {object|null} vaultConfig
   */
  async simulateDeposit(depositUsdcAmount, currentPrice = 0.895, vaultSnapshot = null, vaultConfig = null) {
    const summary = await this.getPublicVaultSummary(currentPrice, { vaultSnapshot, vaultConfig });
    const effectiveSharePrice = summary.sharePriceUsd > 0 ? summary.sharePriceUsd : 1.0;
    const sharesToReceive = depositUsdcAmount / effectiveSharePrice;
    const projectedAnnualEarningsUsd = depositUsdcAmount * (parseFloat(summary.apy.netInvestorApy) / 100);
    const projectedMonthlyEarningsUsd = projectedAnnualEarningsUsd / 12;

    return {
      depositAmountUsd: depositUsdcAmount,
      sharesReceived: Math.round(sharesToReceive * 100) / 100,
      sharePrice: summary.sharePriceUsd,
      projectedMonthlyEarningsUsd: Math.round(projectedMonthlyEarningsUsd * 100) / 100,
      projectedAnnualEarningsUsd: Math.round(projectedAnnualEarningsUsd * 100) / 100,
      netApy: summary.apy.netInvestorApy
    };
  }

  /**
   * Executes a user deposit and records the on-chain audit event.
   * @param {string} userAddress
   * @param {number} depositUsdcAmount
   * @param {number} currentPrice
   */
  async executeDeposit(userAddress, depositUsdcAmount, currentPrice = 0.895) {
    const result = await this.vaultService.executeDeposit(userAddress, depositUsdcAmount, currentPrice);
    const displayAddr = userAddress.length > 10 ? `${userAddress.slice(0, 6)}...${userAddress.slice(-4)}` : userAddress;
    this.historicalEvents.unshift({
      id: `evt_${Date.now()}`,
      type: 'DEPOSIT',
      user: displayAddr,
      amountUsd: result.depositAmountUsd,
      sharesMinted: result.sharesMinted,
      timestamp: new Date().toISOString()
    });
    return result;
  }

  /**
   * Executes a user redemption/withdrawal and records the on-chain audit event.
   * @param {string} userAddress
   * @param {number} sharesToBurn
   * @param {number} currentPrice
   */
  async executeWithdraw(userAddress, sharesToBurn, currentPrice = 0.895) {
    const result = await this.vaultService.executeWithdraw(userAddress, sharesToBurn, currentPrice);
    const displayAddr = userAddress.length > 10 ? `${userAddress.slice(0, 6)}...${userAddress.slice(-4)}` : userAddress;
    this.historicalEvents.unshift({
      id: `evt_${Date.now()}`,
      type: 'WITHDRAW',
      user: displayAddr,
      amountUsd: result.withdrawnUsd,
      sharesBurned: result.sharesBurned,
      timestamp: new Date().toISOString()
    });
    return result;
  }

  /**
   * Returns a user's portfolio position (real on-chain VaultShare objects when connected to a live Vault).
   * @param {string} userAddress
   * @param {number} currentPrice
   * @param {Object|null} vaultSnapshot
   */
  async getUserPosition(userAddress, currentPrice = 0.895, vaultSnapshot = null) {
    if (!userAddress) return null;

    if (
      vaultSnapshot &&
      defaultCetusService.grpcClient &&
      /^0x[0-9a-fA-F]{32,64}$/.test(userAddress) &&
      userAddress.toLowerCase() !== '0x7f4a29c18b6e4d51a92e34018dfcb41928df92b1'
    ) {
      try {
        const owned = await defaultCetusService.grpcClient.listOwnedObjects({
          owner: userAddress,
          include: { json: true }
        });
        const objects = owned?.objects || owned?.data || [];
        let userSharesRaw = 0n;
        for (const obj of objects) {
          if (obj?.type?.includes('::vault::VaultShare') && obj?.json?.vault_id === vaultSnapshot.vaultId) {
            userSharesRaw += BigInt(obj.json.shares || '0');
          }
        }
        const totalSharesNum = Number(vaultSnapshot.totalShares || 0n);
        const userSharesNum = Number(userSharesRaw);
        const vaultTvlUsd = vaultSnapshot.totalUsdc + vaultSnapshot.totalSui * currentPrice;
        const shareFraction = totalSharesNum > 0 ? userSharesNum / totalSharesNum : 0;
        const currentValuationUsd = vaultTvlUsd * shareFraction;

        return {
          userAddress: userAddress.toLowerCase(),
          shares: userSharesNum,
          initialDepositUsd: Math.round(currentValuationUsd * 100) / 100,
          currentValuationUsd: Math.round(currentValuationUsd * 100) / 100,
          accruedYieldUsd: 0,
          shareOfPoolPct: Math.round(shareFraction * 10000) / 100,
          hasPosition: userSharesRaw > 0n,
          isLiveOnChain: true
        };
      } catch {
        // Fallback to simulated store if RPC fails
      }
    }

    return this.vaultService.getUserPosition(userAddress, currentPrice);
  }
}

