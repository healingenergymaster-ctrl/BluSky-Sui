// src/services/bluefin.mjs
// Real Bluefin Pro Perpetual DEX Adapter & Automated Delta-Neutral Short Manager

// Disable axios HTTP/2 experimental default in @bluefin-exchange/pro-sdk before loading SDK
if (!process.env.BLUEFIN_SDK_HTTP_VERSION) {
  process.env.BLUEFIN_SDK_HTTP_VERSION = '1';
}

import {
  BluefinProSdk,
  BluefinRequestSigner,
  OrderSide,
  OrderType,
  makeSigner
} from '@bluefin-exchange/pro-sdk';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { SUI_CONFIG } from '../config.mjs';
import { WalletManager } from './wallet.mjs';
import { calculatePerpMarginHealth } from '../hedging/deltaMath.mjs';

const E9 = 1e9;
const DEFAULT_BLUEFIN_API_HOST = SUI_CONFIG.isTestnet
  ? 'https://api.sui-staging.bluefin.io'
  : 'https://api.sui-prod.bluefin.io';

let _fundingCache = null;
let _fundingCacheAt = 0;

async function fetchBluefinJson(pathname, timeoutMs = 8000) {
  const res = await fetch(`${DEFAULT_BLUEFIN_API_HOST}${pathname}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { ok: res.ok, status: res.status, data: json, rawText: text };
}

function parseE9(val) {
  const num = Number(val);
  return Number.isFinite(num) ? num / E9 : 0;
}

function toE9String(val) {
  return BigInt(Math.round(Number(val) * E9)).toString();
}

/**
 * Quantizes an order quantity down/nearest to Bluefin's discrete stepSize.
 */
export function quantizeOrderQuantity(amountSui, minQty = 1, stepSize = 1) {
  const safeStep = stepSize > 0 ? stepSize : 1;
  const steps = Math.round(Number(amountSui) / safeStep);
  const rounded = Number((steps * safeStep).toFixed(6));
  if (rounded < minQty) return 0;
  return rounded;
}

/**
 * Fetches real-time perpetual funding rate and market ticker directly from Bluefin Pro Mainnet/Testnet,
 * falling back to CoinGecko derivatives index or calibrated benchmark if unreachable.
 */
export async function fetchLivePerpFundingRate(symbol = SUI_CONFIG.hedging.market || 'SUI-PERP') {
  if (_fundingCache && _fundingCache.market === symbol && Date.now() - _fundingCacheAt < 20_000) {
    return _fundingCache;
  }

  try {
    const qSym = encodeURIComponent(symbol);
    const [tickerRes, fundingRes] = await Promise.all([
      fetchBluefinJson(`/v1/exchange/ticker?symbol=${qSym}`, 10000),
      fetchBluefinJson(`/v1/exchange/fundingRateHistory?symbol=${qSym}&limit=8`, 10000).catch(() => null)
    ]);

    const ticker = tickerRes?.ok ? tickerRes.data : null;
    if (ticker) {
      const histArr = Array.isArray(fundingRes?.data) ? fundingRes.data : [];
      const histRates1h = histArr
        .map((h) => (h?.fundingRateE9 !== undefined ? parseE9(h.fundingRateE9) : null))
        .filter((v) => v !== null);
      const lastRate1h = histRates1h.length > 0
        ? histRates1h[0]
        : parseE9(ticker.lastFundingRateE9 ?? 0);
      const histAvg8h = histRates1h.length > 0
        ? histRates1h.reduce((sum, r) => sum + r, 0) / histRates1h.length
        : null;

      // Bluefin Pro settles funding hourly; prefer the 8h rolling average hourly rate
      // (avgFundingRate8hrE9) over the single latest 1h print to smooth short-lived spikes.
      const rate1h = ticker.avgFundingRate8hrE9 !== undefined && ticker.avgFundingRate8hrE9 !== null
        ? parseE9(ticker.avgFundingRate8hrE9)
        : (histAvg8h !== null ? histAvg8h : lastRate1h);

      // Equivalent 8h cumulative rate so existing 1095-period APR math stays exact (rate1h * 8 * 1095 == rate1h * 8760)
      const rate8h = rate1h * 8;
      const annualizedApr = Math.round((rate1h * 24 * 365 * 100) * 10) / 10;

      const result = {
        market: symbol,
        rate1h,
        rate1hPct: Number((rate1h * 100).toFixed(5)),
        lastRate1hPct: Number((lastRate1h * 100).toFixed(5)),
        lastFundingAnnualizedApr: Math.round((lastRate1h * 24 * 365 * 100) * 10) / 10,
        rate8h,
        rate8hPct: Number((rate8h * 100).toFixed(4)),
        avgFundingRate8hrPct: Number((parseE9(ticker.avgFundingRate8hrE9) * 100).toFixed(5)),
        estimatedFundingRatePct: Number((parseE9(ticker.estimatedFundingRateE9) * 100).toFixed(5)),
        annualizedApr,
        markPrice: parseE9(ticker.markPriceE9),
        oraclePrice: parseE9(ticker.oraclePriceE9),
        lastPrice: parseE9(ticker.lastPriceE9),
        bestBid: parseE9(ticker.bestBidPriceE9),
        bestAsk: parseE9(ticker.bestAskPriceE9),
        openInterestSui: parseE9(ticker.openInterestE9),
        volume24hUsd: parseE9(ticker.quoteVolume24hrE9),
        nextFundingTimeAtMillis: ticker.nextFundingTimeAtMillis || null,
        isLive: true,
        source: 'Bluefin Pro API (Sui Mainnet)'
      };
      _fundingCache = result;
      _fundingCacheAt = Date.now();
      return result;
    }
  } catch {}

  try {
    const res = await fetch('https://api.coingecko.com/api/v3/derivatives', { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    const suiPerps = data.filter(x => x.symbol && (x.symbol === 'SUIUSDT' || (x.symbol.includes('SUI') && x.symbol.includes('USDT'))));
    if (suiPerps.length > 0) {
      const avgRatePct = suiPerps.reduce((sum, p) => sum + (Number(p.funding_rate) || 0), 0) / suiPerps.length;
      if (!isNaN(avgRatePct) && avgRatePct !== 0) {
        const rateDecimal = avgRatePct / 100;
        return {
          market: symbol,
          rate1h: rateDecimal / 8,
          rate8h: rateDecimal,
          rate8hPct: Number(avgRatePct.toFixed(4)),
          annualizedApr: Math.round(avgRatePct * 1095 * 10) / 10,
          isLive: true,
          source: 'CoinGecko Live Derivatives Index'
        };
      }
    }
  } catch {}

  return {
    market: symbol,
    rate1h: 0.00001875,
    rate8h: 0.00015,
    rate8hPct: 0.015,
    annualizedApr: 16.4,
    isLive: false,
    source: 'Calibrated Bluefin Benchmark'
  };
}

export class BluefinService {
  constructor(options = {}) {
    this.market = options.market || SUI_CONFIG.hedging.market || 'SUI-PERP';
    this.leverage = options.leverage || SUI_CONFIG.hedging.targetLeverage || 1.0;
    this.environment = options.environment || (SUI_CONFIG.isTestnet ? 'testnet' : 'mainnet');
    this.forceVirtual = Boolean(options.forceVirtual);
    this.walletManager = options.walletManager || new WalletManager();

    this._sdk = null;
    this._sdkInitialized = false;
    this._initPromise = null;
    this._marketRulesCache = null;
    this._marketRulesFetchedAt = 0;

    // Virtual Perpetual Account State (used when EXECUTION_MODE=DRY_RUN or forceVirtual=true)
    this.account = {
      market: this.market,
      shortSizeSui: 0,
      entryPrice: 0,
      marginUsdc: 0,
      realizedPnlUsd: 0,
      fundingAccruedUsd: 0,
      lastFundingTimestamp: Date.now(),
      currentFundingRate8h: 0.00015
    };

    if (options.initialShortSizeSui) {
      this.account.shortSizeSui = options.initialShortSizeSui;
      this.account.entryPrice = options.entryPrice || 0.725;
      this.account.marginUsdc = (this.account.shortSizeSui * this.account.entryPrice) / this.leverage;
    }
  }

  get useLiveExchange() {
    return !this.forceVirtual && SUI_CONFIG.executionMode === 'LIVE' && !this.walletManager.isEphemeral;
  }

  getAccountAddress() {
    return this.walletManager.getAddress();
  }

  _getSuiClient() {
    if (!this._suiClient) {
      const net = this.environment === 'testnet' ? 'testnet' : 'mainnet';
      this._suiClient = new SuiGrpcClient({
        network: net,
        baseUrl: SUI_CONFIG.rpcUrl || 'https://fullnode.mainnet.sui.io:443'
      });
    }
    return this._suiClient;
  }

  _getReadSdk() {
    if (!this._readSdk) {
      const signed = makeSigner(this.walletManager.keypair, false);
      const bfSigner = new BluefinRequestSigner(signed);
      this._readSdk = new BluefinProSdk(bfSigner, this.environment, this._getSuiClient(), {
        disableLoginPromptOnLogout: true
      });
    }
    return this._readSdk;
  }

  async _ensureAuthenticatedSdk() {
    if (this._sdkInitialized && this._sdk) return this._sdk;
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      const sdk = this._getReadSdk();
      // Skip sdk.initializeTxBuilder() because @firefly-exchange/library-sui hits
      // ERR_PACKAGE_PATH_NOT_EXPORTED on @noble/curves@2.4.0 in Node ESM;
      // createOrder() only requires contractsConfig + authenticated session token.
      await sdk.setContractsConfig();
      await sdk.loginAndUpdateToken();
      this._sdk = sdk;
      this._sdkInitialized = true;
      return sdk;
    })();

    try {
      return await this._initPromise;
    } catch (err) {
      this._initPromise = null;
      throw err;
    }
  }

  /**
   * Fetches & caches live SUI-PERP market specifications from Bluefin Pro.
   */
  async getMarketRules(forceRefresh = false) {
    if (!forceRefresh && this._marketRulesCache && Date.now() - this._marketRulesFetchedAt < 300_000) {
      return this._marketRulesCache;
    }
    try {
      const res = await fetchBluefinJson('/v1/exchange/info', 10000);
      const market = res?.ok ? res?.data?.markets?.find((m) => m.symbol === this.market) : null;
      if (market) {
        this._marketRulesCache = {
          symbol: market.symbol,
          status: market.status,
          minOrderQuantity: parseE9(market.minOrderQuantityE9) || 1,
          stepSize: parseE9(market.stepSizeE9) || 1,
          tickSize: parseE9(market.tickSizeE9) || 0.0001,
          initialMarginRatio: parseE9(market.initialMarginRatioE9) || 0.038,
          maintenanceMarginRatio: parseE9(market.maintenanceMarginRatioE9) || 0.018,
          defaultMakerFeePct: parseE9(market.defaultMakerFeeE9) * 100,
          defaultTakerFeePct: parseE9(market.defaultTakerFeeE9) * 100
        };
        this._marketRulesFetchedAt = Date.now();
        return this._marketRulesCache;
      }
    } catch {}

    return {
      symbol: this.market,
      status: 'ACTIVE',
      minOrderQuantity: 1,
      stepSize: 1,
      tickSize: 0.0001,
      initialMarginRatio: 0.038,
      maintenanceMarginRatio: 0.018,
      defaultMakerFeePct: 0.005,
      defaultTakerFeePct: 0.1
    };
  }

  /**
   * Fetches current Bluefin Pro perpetual short position & margin account details.
   * Works in read-only shadow mode (even when HEDGING_ENABLED=false) without requiring login.
   */
  async getPerpPosition(currentPrice = 0.725) {
    if (!this.useLiveExchange) {
      const size = this.account.shortSizeSui;
      const entry = this.account.entryPrice;
      const unrealizedPnlUsd = size > 0 ? size * (entry - currentPrice) : 0;
      const notionalUsd = size * currentPrice;
      const marginHealth = size > 0 ? calculatePerpMarginHealth(size, entry, this.leverage) : null;

      return {
        market: this.market,
        accountAddress: this.getAccountAddress(),
        accountExists: true,
        accountNeedsDeposit: false,
        shortSizeSui: size,
        entryPrice: entry,
        currentPrice,
        notionalUsd,
        unrealizedPnlUsd: Math.round(unrealizedPnlUsd * 100) / 100,
        fundingAccruedUsd: Math.round(this.account.fundingAccruedUsd * 100) / 100,
        realizedPnlUsd: Math.round(this.account.realizedPnlUsd * 100) / 100,
        marginAllocatedUsd: this.account.marginUsdc,
        marginAvailableUsd: this.account.marginUsdc,
        totalAccountValueUsd: this.account.marginUsdc + unrealizedPnlUsd,
        marginHealth,
        isSimulated: true,
        source: 'Virtual Simulator'
      };
    }

    const address = this.getAccountAddress();
    try {
      const res = await fetchBluefinJson(`/api/v1/account?accountAddress=${encodeURIComponent(address)}`, 8000);
      if (res.status === 404) {
        return {
          market: this.market,
          accountAddress: address,
          accountExists: false,
          accountNeedsDeposit: true,
          canTrade: false,
          shortSizeSui: 0,
          entryPrice: 0,
          currentPrice,
          notionalUsd: 0,
          unrealizedPnlUsd: 0,
          fundingAccruedUsd: 0,
          realizedPnlUsd: 0,
          marginAllocatedUsd: 0,
          marginAvailableUsd: 0,
          totalAccountValueUsd: 0,
          marginHealth: null,
          isSimulated: false,
          source: 'Bluefin Pro (No Deposit Yet)'
        };
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const acct = res.data;
      const pos = (acct?.positions || []).find((p) => p.symbol === this.market && parseE9(p.sizeE9) > 0);
      const totalAccountValueUsd = parseE9(acct?.totalAccountValueE9);
      const marginAvailableUsd = parseE9(acct?.marginAvailableE9);
      const effectiveBalanceUsd = parseE9(acct?.crossEffectiveBalanceE9);

      if (!pos) {
        return {
          market: this.market,
          accountAddress: address,
          accountExists: true,
          accountNeedsDeposit: totalAccountValueUsd <= 0,
          canTrade: Boolean(acct?.canTrade),
          shortSizeSui: 0,
          entryPrice: 0,
          currentPrice,
          notionalUsd: 0,
          unrealizedPnlUsd: 0,
          fundingAccruedUsd: 0,
          realizedPnlUsd: 0,
          marginAllocatedUsd: 0,
          marginAvailableUsd: Math.round(marginAvailableUsd * 10000) / 10000,
          totalAccountValueUsd: Math.round(totalAccountValueUsd * 10000) / 10000,
          effectiveBalanceUsd: Math.round(effectiveBalanceUsd * 10000) / 10000,
          marginHealth: null,
          isSimulated: false,
          source: 'Bluefin Pro Live Account'
        };
      }

      const rawSize = parseE9(pos.sizeE9);
      // Represent SHORT exposure positively as shortSizeSui; if unexpectedly LONG, track as negative short
      const signedShortSize = pos.side === OrderSide.Short ? rawSize : -rawSize;
      const entryPrice = parseE9(pos.avgEntryPriceE9);
      const markPrice = parseE9(pos.markPriceE9) || currentPrice;
      const liqPrice = parseE9(pos.liquidationPriceE9);
      const notionalUsd = parseE9(pos.notionalValueE9);
      const unrealizedPnlUsd = parseE9(pos.unrealizedPnlE9);
      const fundingAccruedUsd = parseE9(pos.fundingRatePaymentAllTimeE9);
      const marginAllocatedUsd = pos.isIsolated ? parseE9(pos.isolatedMarginE9) : parseE9(pos.marginRequiredE9);
      const safetyMarginToLiqPct = liqPrice > 0 && markPrice > 0
        ? Math.round(((liqPrice - markPrice) / markPrice) * 1000) / 10
        : null;

      return {
        market: this.market,
        accountAddress: address,
        accountExists: true,
        accountNeedsDeposit: false,
        canTrade: Boolean(acct?.canTrade),
        side: pos.side,
        shortSizeSui: signedShortSize,
        entryPrice,
        currentPrice: markPrice,
        notionalUsd: Math.round(notionalUsd * 10000) / 10000,
        unrealizedPnlUsd: Math.round(unrealizedPnlUsd * 10000) / 10000,
        fundingAccruedUsd: Math.round(fundingAccruedUsd * 10000) / 10000,
        realizedPnlUsd: 0,
        marginAllocatedUsd: Math.round(marginAllocatedUsd * 10000) / 10000,
        marginAvailableUsd: Math.round(marginAvailableUsd * 10000) / 10000,
        totalAccountValueUsd: Math.round(totalAccountValueUsd * 10000) / 10000,
        marginHealth: liqPrice > 0 ? {
          notionalUsd: Math.round(notionalUsd * 100) / 100,
          initialMarginUsd: Math.round(parseE9(pos.marginRequiredE9) * 100) / 100,
          liquidationPrice: Math.round(liqPrice * 10000) / 10000,
          safetyMarginToLiqPct
        } : calculatePerpMarginHealth(Math.max(0, signedShortSize), entryPrice || markPrice, this.leverage),
        isSimulated: false,
        source: 'Bluefin Pro Live Account'
      };
    } catch (err) {
      const status = err?.response?.status;
      if (status === 404) {
        return {
          market: this.market,
          accountAddress: address,
          accountExists: false,
          accountNeedsDeposit: true,
          canTrade: false,
          shortSizeSui: 0,
          entryPrice: 0,
          currentPrice,
          notionalUsd: 0,
          unrealizedPnlUsd: 0,
          fundingAccruedUsd: 0,
          realizedPnlUsd: 0,
          marginAllocatedUsd: 0,
          marginAvailableUsd: 0,
          totalAccountValueUsd: 0,
          marginHealth: null,
          isSimulated: false,
          source: 'Bluefin Pro (No Deposit Yet)'
        };
      }
      throw new Error(`Bluefin Pro account fetch failed: ${err.message}`);
    }
  }

  /**
   * Fetches current funding rate & market ticker from Bluefin Pro API.
   */
  async getFundingRate() {
    const live = await fetchLivePerpFundingRate(this.market);
    if (live.isLive) {
      this.account.currentFundingRate8h = live.rate8h;
    }
    return live;
  }

  /**
   * Adjusts the perpetual short hedge position to match target spot delta.
   * Executes real signed Bluefin Pro Market orders when EXECUTION_MODE=LIVE,
   * or updates the in-memory virtual simulator in DRY_RUN / forceVirtual mode.
   */
  async executeHedgeAdjustment(action, amountSui, currentPrice) {
    if (!this.useLiveExchange) {
      const oldSize = this.account.shortSizeSui;
      let newSize = oldSize;
      let orderDescription = '';

      if (action === 'INCREASE_SHORT') {
        newSize = oldSize + amountSui;
        this.account.entryPrice = oldSize > 0
          ? (oldSize * this.account.entryPrice + amountSui * currentPrice) / newSize
          : currentPrice;
        this.account.marginUsdc += (amountSui * currentPrice) / this.leverage;
        orderDescription = `Opened +${amountSui.toFixed(4)} SUI ${this.leverage}x Short on ${this.market} @ $${currentPrice.toFixed(4)}`;
      } else if (action === 'DECREASE_SHORT') {
        const coverAmount = Math.min(amountSui, oldSize);
        newSize = Math.max(0, oldSize - coverAmount);
        const pnl = coverAmount * (this.account.entryPrice - currentPrice);
        this.account.realizedPnlUsd += pnl;
        const marginReleased = (coverAmount * this.account.entryPrice) / this.leverage;
        this.account.marginUsdc = Math.max(0, this.account.marginUsdc - marginReleased);
        orderDescription = `Covered -${coverAmount.toFixed(4)} SUI Short on ${this.market} @ $${currentPrice.toFixed(4)} (PnL: $${pnl.toFixed(2)})`;
      }

      this.account.shortSizeSui = newSize;

      return {
        status: 'EXECUTED_SIMULATED',
        action,
        amountSui,
        price: currentPrice,
        oldSize,
        newSize,
        newEntryPrice: this.account.entryPrice,
        description: orderDescription,
        timestamp: new Date().toISOString()
      };
    }

    // LIVE Bluefin Pro execution path
    const [rules, livePos] = await Promise.all([
      this.getMarketRules(),
      this.getPerpPosition(currentPrice)
    ]);

    if (!livePos.accountExists || livePos.accountNeedsDeposit) {
      return {
        status: 'SKIPPED_NO_MARGIN',
        action,
        amountSui,
        price: currentPrice,
        oldSize: 0,
        newSize: 0,
        description: `Bluefin Pro account (${livePos.accountAddress}) has no USDC deposit yet — skipping live ${action}.`,
        timestamp: new Date().toISOString()
      };
    }

    const oldSize = Math.max(0, livePos.shortSizeSui);
    let targetQty = quantizeOrderQuantity(amountSui, rules.minOrderQuantity, rules.stepSize);
    if (action === 'DECREASE_SHORT') {
      targetQty = Math.min(targetQty, quantizeOrderQuantity(oldSize, rules.minOrderQuantity, rules.stepSize));
    }

    if (targetQty < rules.minOrderQuantity) {
      return {
        status: 'SKIPPED_BELOW_MIN_STEP',
        action,
        amountSui,
        minOrderQuantity: rules.minOrderQuantity,
        oldSize,
        newSize: oldSize,
        description: `Adjustment (${amountSui.toFixed(3)} SUI) rounds below Bluefin Pro minimum lot (${rules.minOrderQuantity} SUI).`,
        timestamp: new Date().toISOString()
      };
    }

    if (action === 'INCREASE_SHORT') {
      const execPrice = livePos.currentPrice || currentPrice;
      const neededMargin = ((targetQty * execPrice) / this.leverage) * 1.05;
      if (livePos.marginAvailableUsd < neededMargin) {
        return {
          status: 'SKIPPED_INSUFFICIENT_MARGIN',
          action,
          amountSui: targetQty,
          marginAvailableUsd: livePos.marginAvailableUsd,
          requiredMarginUsd: Math.round(neededMargin * 100) / 100,
          oldSize,
          newSize: oldSize,
          description: `Insufficient Bluefin Pro free margin ($${livePos.marginAvailableUsd.toFixed(2)} avail vs $${neededMargin.toFixed(2)} needed for ${targetQty} SUI short).`,
          timestamp: new Date().toISOString()
        };
      }
    }

    const sdk = await this._ensureAuthenticatedSdk();
    const isReduce = action === 'DECREASE_SHORT';
    const orderSide = isReduce ? OrderSide.Long : OrderSide.Short;
    const clientOrderId = `blusky-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    const orderResponse = await sdk.createOrder({
      clientOrderId,
      symbol: this.market,
      type: OrderType.Market,
      side: orderSide,
      priceE9: '0',
      quantityE9: toE9String(targetQty),
      leverageE9: toE9String(this.leverage),
      isIsolated: false,
      reduceOnly: isReduce,
      postOnly: false,
      expiresAtMillis: Date.now() + 60_000
    });

    const refreshed = await this.getPerpPosition(currentPrice);
    const description = isReduce
      ? `Covered -${targetQty} SUI Short on Bluefin Pro ${this.market} @ ~$${(livePos.currentPrice || currentPrice).toFixed(4)} (New Short: ${refreshed.shortSizeSui} SUI)`
      : `Opened +${targetQty} SUI ${this.leverage}x Short on Bluefin Pro ${this.market} @ ~$${(livePos.currentPrice || currentPrice).toFixed(4)} (New Short: ${refreshed.shortSizeSui} SUI)`;

    return {
      status: 'EXECUTED_LIVE',
      action,
      amountSui: targetQty,
      price: livePos.currentPrice || currentPrice,
      oldSize,
      newSize: refreshed.shortSizeSui,
      newEntryPrice: refreshed.entryPrice,
      clientOrderId,
      orderHash: orderResponse?.data?.orderHash || orderResponse?.data?.id || null,
      description,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Deposits native Circle USDC on Sui into the Bluefin Pro margin bank (amount in USDC).
   * Builds and executes the Move PTB directly via SuiGrpcClient to avoid upstream
   * @firefly-exchange/library-sui ESM export incompatibility in Node.
   */
  async depositUsdc(amountUsdc) {
    const parsedAmount = Number(amountUsdc);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      throw new Error(`Invalid USDC deposit amount: ${amountUsdc}`);
    }
    if (this.walletManager.isEphemeral || !this.walletManager.keypair) {
      throw new Error('Cannot deposit USDC: configured signer Keypair is required');
    }

    const res = await fetchBluefinJson('/v1/exchange/info', 10000);
    const contracts = res?.data?.contractsConfig;
    const usdcAsset = res?.data?.assets?.find((a) => a.symbol === 'USDC');
    const pkg = contracts?.currentContractAddress;
    const edsId = contracts?.edsId;
    const usdcType = usdcAsset?.assetType || SUI_CONFIG.coins.USDC;
    const decimals = Number(usdcAsset?.decimals ?? 6);
    if (!pkg || !edsId) {
      throw new Error('Missing Bluefin contractsConfig from /v1/exchange/info');
    }

    const rawAmount = BigInt(Math.round(parsedAmount * (10 ** decimals)));
    const sender = this.getAccountAddress();
    const tx = new Transaction();
    tx.setSender(sender);

    const depCoin = tx.add(coinWithBalance({ type: usdcType, balance: rawAmount }));
    tx.moveCall({
      target: `${pkg}::exchange::deposit_to_asset_bank`,
      typeArguments: [usdcType],
      arguments: [
        tx.object(edsId),
        tx.pure.string('USDC'),
        tx.pure.address(sender),
        tx.pure.u64(rawAmount),
        depCoin
      ]
    });
    // deposit_to_asset_bank takes &mut Coin<USDC>, so return the spent coin to sender
    tx.transferObjects([depCoin], tx.pure.address(sender));

    const grpcClient = this._getSuiClient();
    const result = await grpcClient.signAndExecuteTransaction({
      transaction: tx,
      signer: this.walletManager.keypair,
      include: {
        effects: true,
        events: true,
        balanceChanges: true
      }
    });

    const txRecord = result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction;
    const digest = txRecord?.digest;
    if (digest) {
      await grpcClient.waitForTransaction({ digest });
    }
    if (result.$kind === 'FailedTransaction' || !txRecord?.status?.success) {
      const errDetail = JSON.stringify(txRecord?.status?.error || result);
      throw new Error(`Bluefin depositUsdc PTB failed (digest: ${digest}): ${errDetail}`);
    }

    return {
      digest,
      amountUsdc: parsedAmount,
      rawAmount: rawAmount.toString(),
      accountAddress: sender,
      events: txRecord.events || [],
      balanceChanges: txRecord.balanceChanges || []
    };
  }

  /**
   * Simulates funding rate accrual payment in virtual mode.
   */
  accrueFunding(elapsedHours = 8, currentPrice = 0.725) {
    if (this.account.shortSizeSui <= 0) return 0;
    const periods = elapsedHours / 8;
    const notional = this.account.shortSizeSui * currentPrice;
    const payment = notional * this.account.currentFundingRate8h * periods;
    this.account.fundingAccruedUsd += payment;
    return payment;
  }

  async dispose() {
    if (this._sdk) {
      try {
        await this._sdk.dispose();
      } catch {}
      this._sdk = null;
      this._sdkInitialized = false;
      this._initPromise = null;
    }
  }
}
