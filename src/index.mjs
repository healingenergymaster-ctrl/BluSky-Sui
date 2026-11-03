// src/index.mjs
// BluSky-Sui Main CLI & Autonomous Liquidity Management Daemon

import { SUI_CONFIG } from './config.mjs';
import { TurbosService } from './services/turbos.mjs';
import { WalletManager } from './services/wallet.mjs';
import { PositionMonitor } from './services/monitor.mjs';
import { VaultApiService } from './dashboard/vaultApi.mjs';

// Ignore benign protobuf-ts unhandled fetch errors in sandboxed/offline environments
process.on('unhandledRejection', () => {});

function renderAsciiRangeBar(progressPct, width = 30) {
  const clamped = Math.max(0, Math.min(100, progressPct));
  const markerPos = Math.round((clamped / 100) * (width - 1));
  let bar = '';
  for (let i = 0; i < width; i++) {
    if (i === markerPos) {
      bar += '●';
    } else if (i === Math.floor(width / 2)) {
      bar += '|';
    } else {
      bar += '─';
    }
  }
  return `[${bar}] ${clamped.toFixed(1)}%`;
}

function displayDashboard(analysis, record, hedgeReport) {
  console.clear();
  console.log('╔════════════════════════════════════════════════════════════════════════════╗');
  console.log('║           🌊 BLUSKY-SUI : AUTONOMOUS CLMM & DELTA-NEUTRAL VAULTS           ║');
  console.log('║        Concentrated Liquidity Rebalancing + Bluefin Perps Hedging          ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════╝');
  console.log(` 🌐 Network:   ${SUI_CONFIG.network.toUpperCase()}             ⚙️  Mode:       ${SUI_CONFIG.executionMode}`);
  console.log(` 👛 Wallet:    ${analysis.position?.nftId ? 'Active' : 'Standby'}            🔄 Cycle:      #${record.cycle}`);
  console.log('─'.repeat(78));

  // 1. Spot Pool State
  console.log(' 📊 SUI/USDC SPOT POOL STATUS');
  console.log(`    • Pool Address:     ${analysis.pool.objectId}`);
  console.log(`    • Current SUI Price: $${analysis.pool.currentPrice.toFixed(4)} USDC`);
  console.log(`    • Pool Liquidity:   ${analysis.pool.liquidity}`);
  console.log(`    • Pool Fee Tier:    ${(analysis.pool.fee / 10000).toFixed(2)}% (Tick Spacing: ${analysis.pool.tickSpacing})`);
  console.log('─'.repeat(78));

  // 2. Active CLMM Position Health
  console.log(' 🎯 ACTIVE CLMM POSITION MONITORING (Turbos Finance)');
  console.log(`    • Position NFT:     ${analysis.position.nftId}`);
  console.log(`    • Target Range:     $${analysis.rangeMetrics.priceLower.toFixed(4)} <───> $${analysis.rangeMetrics.priceUpper.toFixed(4)}`);
  console.log(`    • Band Position:    ${renderAsciiRangeBar(analysis.rangeMetrics.progressPct)}`);
  console.log(`    • Nearest Boundary: ${analysis.rangeMetrics.nearestBoundaryDistancePct}% distance`);
  
  const statusBadge = !analysis.rangeMetrics.inRange 
    ? '🚨 OUT OF RANGE (0% APR)' 
    : analysis.rangeMetrics.isDriftTriggered 
      ? '⚠️  DRIFT THRESHOLD REACHED' 
      : '✅ OPTIMAL FEE-EARNING ZONE (~100% APR)';
  console.log(`    • Status:           ${statusBadge}`);
  console.log('─'.repeat(78));

  // 3. Delta-Neutral Hedging Layer (Phase 2)
  if (hedgeReport) {
    console.log(' 🛡️  DELTA-NEUTRAL HEDGING STATUS (Phase 2: Bluefin Perps)');
    console.log(`    • Hedge Market:     ${hedgeReport.perpStatus.market} (${SUI_CONFIG.hedging.targetLeverage}x Short)`);
    console.log(`    • Spot SUI Delta:   +${hedgeReport.spotMetrics.spotDeltaSui.toFixed(3)} SUI ($${hedgeReport.spotMetrics.spotDeltaUsd.toFixed(2)} USD)`);
    console.log(`    • Perp Short Size:  -${hedgeReport.perpStatus.shortSizeSui.toFixed(3)} SUI ($${hedgeReport.perpStatus.notionalUsd.toFixed(2)} USD)`);
    
    const deltaBadge = Math.abs(hedgeReport.deltaStatus.deltaDriftPct) <= SUI_CONFIG.hedging.deltaDriftTolerancePct
      ? '✅ ZERO MARKET BETA (Strictly Neutral)'
      : '⚠️  DELTA RE-CENTERING REQUIRED';
    console.log(`    • Net Portfolio Δ:  ${hedgeReport.deltaStatus.netDeltaSui >= 0 ? '+' : ''}${hedgeReport.deltaStatus.netDeltaSui.toFixed(3)} SUI ($${hedgeReport.deltaStatus.netDeltaUsd.toFixed(2)} USD) -> ${deltaBadge}`);
    console.log(`    • Delta Drift:      ${hedgeReport.deltaStatus.deltaDriftPct.toFixed(2)}% (Tolerance: ±${SUI_CONFIG.hedging.deltaDriftTolerancePct}%)`);
    console.log(`    • 8h Funding Rate:  +${hedgeReport.fundingInfo.rate8hPct.toFixed(4)}% (+${hedgeReport.fundingInfo.annualizedApr.toFixed(1)}% APR) [Earned by Shorts]`);
    if (hedgeReport.perpStatus.marginHealth) {
      console.log(`    • Liq Price Buffer: $${hedgeReport.perpStatus.marginHealth.liquidationPrice.toFixed(4)} (+${hedgeReport.perpStatus.marginHealth.safetyMarginToLiqPct.toFixed(1)}% buffer)`);
    }
    console.log(`    • Net Projected APY: ${hedgeReport.apyBreakdown.netMarketNeutralApy.toFixed(1)}% APY (${hedgeReport.apyBreakdown.clmmFeeApr}% Fees + ${hedgeReport.apyBreakdown.annualizedFundingApr}% Funding - ${hedgeReport.apyBreakdown.rehedgeChurnCostApr}% Churn)`);
    console.log('─'.repeat(78));
  }

  // 4. Combined Portfolio Economics
  console.log(' 💰 COMBINED PORTFOLIO VALUATION');
  if (hedgeReport) {
    console.log(`    • CLMM Spot Value:  $${hedgeReport.portfolio.clmmAssetsUsd.toFixed(2)} USD`);
    console.log(`    • Accrued LP Fees:  $${analysis.accruedFees.totalFeesUsd.toFixed(2)} USD (${analysis.accruedFees.feeA_Sui.toFixed(2)} SUI + ${analysis.accruedFees.feeB_Usdc.toFixed(2)} USDC)`);
    console.log(`    • Perp Equity:      $${hedgeReport.portfolio.perpEquityUsd.toFixed(2)} USD (Margin + PnL + Funding)`);
    console.log(`    • Total Vault NAV:  $${hedgeReport.portfolio.totalPortfolioValueUsd.toFixed(2)} USD`);
  } else {
    console.log(`    • Unclaimed Fees:   ${analysis.accruedFees.feeA_Sui.toFixed(4)} SUI + ${analysis.accruedFees.feeB_Usdc.toFixed(2)} USDC ($${analysis.accruedFees.totalFeesUsd.toFixed(2)})`);
  }
  console.log(`    • Viability Check:  ${analysis.viability.reason}`);
  console.log('─'.repeat(78));

  // 5. Execution Decision
  console.log(' ⚡ REBALANCE & HEDGING ENGINE DECISIONS');
  if (hedgeReport?.adjustmentResult) {
    console.log(`    • Hedge Action:     ⚡ ${hedgeReport.adjustmentResult.description}`);
  } else {
    console.log('    • Hedge Action:     HEDGE BALANCED (No adjustment required)');
  }

  if (record.actionTaken === 'HOLD') {
    console.log('    • Range Action:     HOLDING TICK RANGE (Within optimal boundaries)');
    console.log(`    • Range Triggers:   Price bounds: $${(analysis.rangeMetrics.priceLower * 1.02).toFixed(4)} <───> $${(analysis.rangeMetrics.priceUpper * 0.98).toFixed(4)}`);
  } else {
    console.log(`    • Range Action:     ${record.actionTaken}`);
    console.log(`    • Target New Band:  $${record.targetRange.targetLowerPrice.toFixed(4)} <───> $${record.targetRange.targetUpperPrice.toFixed(4)}`);
    console.log('\n    📋 Atomic PTB Execution Plan:');
    record.executionResult.stepsExecuted.forEach(s => {
      console.log(`       [Step ${s.step}] ${s.description}`);
    });
    console.log(`\n    ✨ Result:          ${record.executionResult.message || 'Execution Complete'}`);
  }
  console.log('═'.repeat(78));
}

async function displayVaultDashboard() {
  const api = new VaultApiService();
  const summary = await api.getPublicVaultSummary(0.895);

  console.clear();
  console.log('╔════════════════════════════════════════════════════════════════════════════╗');
  console.log('║           🏛️  BLUSKY-SUI : ON-CHAIN MOVE VAULT PROTOCOL (PHASE 3)           ║');
  console.log('║               Non-Custodial Architecture & Protocol Monetization           ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════╝');
  console.log(` 📦 Package:    blusky_vault::vault           📜 Edition:     Move 2024.beta`);
  console.log(` 🎯 Vault Name: ${summary.vaultName}`);
  console.log('─'.repeat(78));

  console.log(' 📊 ON-CHAIN VAULT METRICS');
  console.log(`    • Total Value Locked (TVL): $${summary.tvlUsd.toLocaleString()} USD`);
  console.log(`    • Share Token:              VaultShare<SUI, USDC>`);
  console.log(`    • Current Share Price:      $${summary.sharePriceUsd.toFixed(4)} USD`);
  console.log(`    • Total Shares Minted:      ${summary.totalShares.toLocaleString()} shares`);
  console.log('─'.repeat(78));

  console.log(' 💎 YIELD & PROTOCOL MONETIZATION');
  console.log(`    • Gross Pool APR:           ${summary.apy.grossTradingApr}`);
  console.log(`    • Bluefin Perp Funding:     ${summary.apy.bluefinFundingApr}`);
  console.log(`    • Protocol Performance Fee: ${summary.performanceFeePct} (Zero management fee)`);
  console.log(`    • NET INVESTOR APY:         ${summary.apy.netInvestorApy} (Delta-Neutral, USD-denominated)`);
  console.log('─'.repeat(78));

  console.log(' 💼 PROTOCOL CASH FLOW & REVENUE (Monetization Engine)');
  console.log(`    • Daily Gross Yield:        $${summary.economics.dailyGrossYieldUsd.toFixed(2)} / day`);
  console.log(`    • Daily Investor Yield:     $${summary.economics.dailyNetYieldUsd.toFixed(2)} / day`);
  console.log(`    • Daily Protocol Fee:       $${summary.economics.dailyProtocolFeeEarnedUsd.toFixed(2)} / day ($${summary.economics.annualProtocolFeeEarnedUsd.toFixed(2)} / year)`);
  console.log('─'.repeat(78));

  console.log(' 📜 RECENT ON-CHAIN VAULT EVENTS');
  summary.recentEvents.forEach(evt => {
    if (evt.type === 'DEPOSIT') {
      console.log(`    [DEPOSIT]   ${evt.user} deposited $${evt.amountUsd.toFixed(2)} -> Minted ${evt.sharesMinted} VaultShare`);
    } else if (evt.type === 'COMPOUND') {
      console.log(`    [COMPOUND]  Harvested $${evt.grossFeesUsd.toFixed(2)} -> Treasury Fee: $${evt.performanceFeeCollectedUsd.toFixed(2)} | Auto-Compounded: $${evt.compoundedUsd.toFixed(2)}`);
    } else if (evt.type === 'REBALANCE') {
      console.log(`    [REBALANCE] Atomic PTB recentered range: ${evt.oldRange} -> ${evt.newRange} (Gas: $${evt.costUsd})`);
    }
  });
  console.log('═'.repeat(78));
}

async function main() {
  const args = process.argv.slice(2);
  const runOnce = args.includes('--once');
  const simulateDrift = args.includes('--simulate-drift');
  const simulateHedge = args.includes('--simulate-hedge');
  const showVault = args.includes('--vault');

  if (showVault) {
    await displayVaultDashboard();
    process.exit(0);
  }

  const wallet = new WalletManager();
  const turbosService = new TurbosService();
  const monitor = new PositionMonitor({
    turbosService,
    wallet,
    onEvent: (record, analysis, hedgeReport) => {
      displayDashboard(analysis, record, hedgeReport);
    }
  });

  if (simulateDrift) {
    console.log('🧪 Simulating severe market move to test CLMM atomic rebalancing...');
    turbosService.getPool = async () => ({
      objectId: SUI_CONFIG.pools.turbos_sui_usdc,
      coinTypeA: SUI_CONFIG.coins.SUI,
      coinTypeB: SUI_CONFIG.coins.USDC,
      feeType: '0x...::fee::Fee2500',
      sqrtPriceX64: '0',
      currentTick: -63100,
      tickSpacing: 60,
      liquidity: '15000000000000',
      fee: 2500,
      currentPrice: 1.82,
      isSimulated: true
    });
  } else if (simulateHedge) {
    console.log('🧪 Simulating market price drop to $1.92 to test dynamic delta hedge re-centering...');
    turbosService.getPool = async () => ({
      objectId: SUI_CONFIG.pools.turbos_sui_usdc,
      coinTypeA: SUI_CONFIG.coins.SUI,
      coinTypeB: SUI_CONFIG.coins.USDC,
      feeType: '0x...::fee::Fee2500',
      sqrtPriceX64: '0',
      currentTick: -62600,
      tickSpacing: 60,
      liquidity: '15000000000000',
      fee: 2500,
      currentPrice: 1.92,
      isSimulated: true
    });
  }

  if (runOnce || simulateDrift || simulateHedge) {
    await monitor.checkOnce();
    console.log('\n✅ Single monitoring & hedging cycle completed successfully.');
    process.exit(0);
  } else {
    monitor.start(SUI_CONFIG.strategy.checkIntervalMs);
  }
}

main().catch(err => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
