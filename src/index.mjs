// src/index.mjs
// BluSky-Sui Main CLI & Liquidity Management Daemon

import { SUI_CONFIG } from './config.mjs';
import { TurbosService } from './services/turbos.mjs';
import { WalletManager } from './services/wallet.mjs';
import { PositionMonitor } from './services/monitor.mjs';

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

function displayDashboard(analysis, record) {
  console.clear();
  console.log('╔════════════════════════════════════════════════════════════════════════════╗');
  console.log('║           🌊 BLUSKY-SUI : AUTONOMOUS CLMM LIQUIDITY PROTOCOL               ║');
  console.log('║             High-Frequency Volatility-Adaptive Liquidity Engine            ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════╝');
  console.log(` 🌐 Network:   ${SUI_CONFIG.network.toUpperCase()}             ⚙️  Mode:       ${SUI_CONFIG.executionMode}`);
  console.log(` 👛 Wallet:    ${analysis.position?.nftId ? 'Active' : 'Standby'}            🔄 Cycle:      #${record.cycle}`);
  console.log('─'.repeat(78));

  // Spot Pool State
  console.log(' 📊 SUI/USDC SPOT POOL STATUS');
  console.log(`    • Pool Address:     ${analysis.pool.objectId}`);
  console.log(`    • Current SUI Price: $${analysis.pool.currentPrice.toFixed(4)} USDC`);
  console.log(`    • Pool Liquidity:   ${analysis.pool.liquidity}`);
  console.log(`    • Pool Fee Tier:    ${(analysis.pool.fee / 10000).toFixed(2)}% (Tick Spacing: ${analysis.pool.tickSpacing})`);
  console.log('─'.repeat(78));

  // Active Position Health
  console.log(' 🎯 ACTIVE POSITION MONITORING');
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

  // Fee Generation & Economics
  console.log(' 💰 FEE HARVEST & REBALANCE ECONOMICS');
  console.log(`    • Unclaimed Fees:   ${analysis.accruedFees.feeA_Sui.toFixed(4)} SUI + ${analysis.accruedFees.feeB_Usdc.toFixed(2)} USDC`);
  console.log(`    • Total Fee Value:  $${analysis.accruedFees.totalFeesUsd.toFixed(2)} USD`);
  console.log(`    • Viability Check:  ${analysis.viability.reason}`);
  console.log('─'.repeat(78));

  // Action / Execution Status
  console.log(' ⚡ REBALANCE ENGINE DECISION');
  if (record.actionTaken === 'HOLD') {
    console.log('    • Action:           HOLDING POSITION (No intervention needed)');
    console.log(`    • Next Trigger:     Rebalance if price touches $${(analysis.rangeMetrics.priceLower * 1.02).toFixed(4)} or $${(analysis.rangeMetrics.priceUpper * 0.98).toFixed(4)}`);
  } else {
    console.log(`    • Action:           ${record.actionTaken}`);
    console.log(`    • Target New Band:  $${record.targetRange.targetLowerPrice.toFixed(4)} <───> $${record.targetRange.targetUpperPrice.toFixed(4)}`);
    console.log('\n    📋 Atomic PTB Execution Plan:');
    record.executionResult.stepsExecuted.forEach(s => {
      console.log(`       [Step ${s.step}] ${s.description}`);
    });
    console.log(`\n    ✨ Result:          ${record.executionResult.message || 'Execution Complete'}`);
  }
  console.log('═'.repeat(78));
}

async function main() {
  const args = process.argv.slice(2);
  const runOnce = args.includes('--once');
  const simulateDrift = args.includes('--simulate-drift');

  const wallet = new WalletManager();
  const turbosService = new TurbosService();
  const monitor = new PositionMonitor({
    turbosService,
    wallet,
    onEvent: (record, analysis) => {
      displayDashboard(analysis, record);
    }
  });

  if (simulateDrift) {
    console.log('🧪 Simulating severe market move to test atomic rebalancing...');
    // Override pool price to trigger drift boundary
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
      currentPrice: 1.82, // Near $1.80 lower bound!
      isSimulated: true
    });
  }

  if (runOnce) {
    await monitor.checkOnce();
    console.log('\n✅ Single monitoring cycle completed successfully.');
    process.exit(0);
  } else {
    monitor.start(SUI_CONFIG.strategy.checkIntervalMs);
  }
}

main().catch(err => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
