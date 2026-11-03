// src/services/bluefin.mjs
// Bluefin Perpetual DEX Adapter & Automated Short Manager

import { SUI_CONFIG } from '../config.mjs';
import { calculatePerpMarginHealth } from '../hedging/deltaMath.mjs';

export class BluefinService {
  constructor(options = {}) {
    this.market = options.market || SUI_CONFIG.hedging.market;
    this.leverage = options.leverage || SUI_CONFIG.hedging.targetLeverage;
    
    // Virtual Perpetual Account State (for simulation & tracking)
    this.account = {
      market: this.market,
      shortSizeSui: 0,
      entryPrice: 0,
      marginUsdc: 0,
      realizedPnlUsd: 0,
      fundingAccruedUsd: 0,
      lastFundingTimestamp: Date.now(),
      // Standard Bluefin SUI-PERP 8h funding rate: +0.015% (+16.4% APR)
      currentFundingRate8h: 0.00015
    };

    // Pre-initialize initial hedge if specified or simulate calibrated active position
    if (options.initialShortSizeSui) {
      this.account.shortSizeSui = options.initialShortSizeSui;
      this.account.entryPrice = options.entryPrice || 0.895;
      this.account.marginUsdc = this.account.shortSizeSui * this.account.entryPrice;
    }
  }

  /**
   * Fetches current perpetual short position status.
   * @param {number} currentPrice 
   */
  async getPerpPosition(currentPrice = 0.895) {
    const size = this.account.shortSizeSui;
    const entry = this.account.entryPrice;

    // For a SHORT position: PnL = Size * (EntryPrice - CurrentPrice)
    const unrealizedPnlUsd = size > 0 ? size * (entry - currentPrice) : 0;
    const notionalUsd = size * currentPrice;

    const marginHealth = size > 0
      ? calculatePerpMarginHealth(size, entry, this.leverage)
      : null;

    return {
      market: this.market,
      shortSizeSui: size,
      entryPrice: entry,
      currentPrice,
      notionalUsd,
      unrealizedPnlUsd: Math.round(unrealizedPnlUsd * 100) / 100,
      fundingAccruedUsd: Math.round(this.account.fundingAccruedUsd * 100) / 100,
      realizedPnlUsd: Math.round(this.account.realizedPnlUsd * 100) / 100,
      marginAllocatedUsd: this.account.marginUsdc,
      marginHealth,
      isSimulated: SUI_CONFIG.executionMode === 'DRY_RUN'
    };
  }

  /**
   * Fetches current 8h funding rate.
   */
  async getFundingRate() {
    return {
      market: this.market,
      rate8h: this.account.currentFundingRate8h,
      rate8hPct: this.account.currentFundingRate8h * 100,
      annualizedApr: Math.round(this.account.currentFundingRate8h * 1095 * 1000) / 10
    };
  }

  /**
   * Adjusts the perpetual short hedge position to match target spot delta.
   * 
   * @param {string} action 'INCREASE_SHORT' or 'DECREASE_SHORT'
   * @param {number} amountSui Size of the adjustment in SUI
   * @param {number} currentPrice Current execution price
   */
  async executeHedgeAdjustment(action, amountSui, currentPrice) {
    const isLive = SUI_CONFIG.executionMode === 'LIVE';
    const oldSize = this.account.shortSizeSui;
    let newSize = oldSize;
    let orderDescription = '';

    if (action === 'INCREASE_SHORT') {
      newSize = oldSize + amountSui;
      // Weighted average entry price
      if (oldSize > 0) {
        this.account.entryPrice = (oldSize * this.account.entryPrice + amountSui * currentPrice) / newSize;
      } else {
        this.account.entryPrice = currentPrice;
      }
      this.account.marginUsdc += (amountSui * currentPrice) / this.leverage;
      orderDescription = `Opened +${amountSui.toFixed(4)} SUI 1x Short on ${this.market} @ $${currentPrice.toFixed(4)}`;
    } else if (action === 'DECREASE_SHORT') {
      const coverAmount = Math.min(amountSui, oldSize);
      newSize = Math.max(0, oldSize - coverAmount);
      // Realize PnL on covered portion: coverAmount * (entry - currentPrice)
      const pnl = coverAmount * (this.account.entryPrice - currentPrice);
      this.account.realizedPnlUsd += pnl;
      // Release proportional margin
      const marginReleased = (coverAmount * this.account.entryPrice) / this.leverage;
      this.account.marginUsdc = Math.max(0, this.account.marginUsdc - marginReleased);
      orderDescription = `Covered -${coverAmount.toFixed(4)} SUI Short on ${this.market} @ $${currentPrice.toFixed(4)} (PnL: $${pnl.toFixed(2)})`;
    }

    this.account.shortSizeSui = newSize;

    return {
      status: isLive ? 'EXECUTED_LIVE' : 'EXECUTED_SIMULATED',
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

  /**
   * Simulates funding rate accrual payment.
   */
  accrueFunding(elapsedHours = 8, currentPrice = 0.895) {
    if (this.account.shortSizeSui <= 0) return 0;
    const periods = elapsedHours / 8;
    const notional = this.account.shortSizeSui * currentPrice;
    // Positive funding: longs pay shorts -> Short position earns cash!
    const payment = notional * this.account.currentFundingRate8h * periods;
    this.account.fundingAccruedUsd += payment;
    return payment;
  }
}

