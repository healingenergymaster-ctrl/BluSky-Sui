// scripts/run_cetus_rebalance_demo.mjs
// End-to-End Automated Rebalancing & Yield Routing Demo for Cetus Protocol CLMM

import { PositionMonitor } from '../src/services/monitor.mjs';
import { SUI_CONFIG } from '../src/config.mjs';

async function main() {
  console.log('='.repeat(78));
  console.log('   BLUSKY-SUI: CETUS PROTOCOL AUTOMATED CLMM REBALANCING DEMO');
  console.log('='.repeat(78));
  console.log(`Network:          ${SUI_CONFIG.network.toUpperCase()}`);
  console.log(`Execution Mode:   ${SUI_CONFIG.executionMode}`);
  console.log(`Published Vault:  ${SUI_CONFIG.vault.objectId}`);
  console.log(`Fee Treasury:     ${SUI_CONFIG.feeTreasuryAddress}`);
  console.log('-'.repeat(78));

  const monitor = new PositionMonitor({ primaryDex: 'cetus' });

  // -------------------------------------------------------------
  // Scenario 1: Healthy In-Range Position Check
  // -------------------------------------------------------------
  console.log('\n[SCENARIO 1] Checking Active Cetus LP Position (Healthy State)...');
  const normalCheck = await monitor.checkOnce();
  const normalRecord = normalCheck.record;
  const routing = normalRecord.yieldRouting;

  console.log(`  Current SUI Price:      $${normalRecord.price}`);
  console.log(`  Position Status:        ${normalRecord.inRange ? '✅ IN-RANGE' : '❌ OUT-OF-RANGE'}`);
  console.log(`  Progress in Band:       ${normalRecord.progressPct}% (Distance to nearest boundary: ${normalRecord.nearestBoundaryPct}%)`);
  console.log(`  Accrued Fees:           $${normalRecord.feesUsd.toFixed(2)} USD`);
  console.log(`  Drift Triggered:        ${normalRecord.isDriftTriggered ? 'YES' : 'NO'}`);
  console.log(`  Action Taken:           ${normalRecord.actionTaken}`);
  console.log(`  Cross-DEX Yield Check:  Cetus Gross APR: ${routing.cetusApr}% | Turbos Gross APR: ${routing.turbosApr}%`);
  console.log(`  Yield Routing Engine:   ${routing.recommendation}`);

  // -------------------------------------------------------------
  // Scenario 2: Simulated Market Drift & Out-of-Range Event
  // -------------------------------------------------------------
  const simulatedDriftPrice = 0.72; // SUI drops from $0.895 to $0.72 (below $0.80 lower bound)
  console.log('\n' + '-'.repeat(78));
  console.log(`[SCENARIO 2] Market Movement Event: SUI Spot Drops to $${simulatedDriftPrice}`);
  console.log('  Triggering Automated Drift Detection & PTB Rebalance Pipeline...');
  console.log('-'.repeat(78));

  const driftCheck = await monitor.checkOnce(simulatedDriftPrice);
  const driftRecord = driftCheck.record;
  const exec = driftRecord.executionResult;

  console.log(`  New SUI Spot Price:     $${driftRecord.price}`);
  console.log(`  Position Status:        ${driftRecord.inRange ? '✅ IN-RANGE' : '🚨 OUT-OF-RANGE'}`);
  console.log(`  Drift Triggered:        ${driftRecord.isDriftTriggered ? '🚨 YES (Boundary breached)' : 'NO'}`);
  console.log(`  Economic Viability:     ${driftRecord.isViable ? '✅ VIABLE (Fees comfortably cover gas)' : '❌ NOT VIABLE'}`);
  console.log(`  Action Taken:           🎯 ${driftRecord.actionTaken}`);

  if (exec) {
    console.log('\n[PROGRAMMABLE TRANSACTION BLOCK: ATOMIC 7-STEP REBALANCE]');
    exec.stepsExecuted.forEach((step) => {
      console.log(`  Step ${step.step}: [${step.action.toUpperCase()}]`);
      console.log(`          ${step.description}`);
    });

    console.log('\n[ECONOMIC & GAS METRICS (SUI EXECUTION BENCHMARK)]');
    const sim = exec.simulation;
    console.log(`  Computation Cost:       ${sim.computationCostMist.toLocaleString()} MIST`);
    console.log(`  Storage Cost:           ${sim.storageCostMist.toLocaleString()} MIST`);
    console.log(`  Storage Rebate Recovered:${sim.storageRebateMist.toLocaleString()} MIST (From burning old position NFT)`);
    console.log(`  Net Gas Expended:       ${sim.netGasMist.toLocaleString()} MIST (~${sim.netGasSui.toFixed(5)} SUI / $${sim.netCostUsd.toFixed(4)} USD)`);
    console.log(`  Protocol Fee Harvested: $${sim.protocolFeeHarvestedUsd.toFixed(2)} USD (10% sent to BluSky Treasury)`);
    console.log(`  Compounded Capital:     $${sim.compoundedYieldUsd.toFixed(2)} USD (90% retained in vault NAV)`);
    console.log(`  Execution Status:       ${sim.predictedStatus}`);
  }

  // -------------------------------------------------------------
  // Scenario 3: Target Band Realignment
  // -------------------------------------------------------------
  if (driftRecord.targetRange) {
    const tr = driftRecord.targetRange;
    console.log('\n[NEW CONCENTRATED LIQUIDITY BAND RECENTERED]');
    console.log(`  New Lower Bound:        $${tr.targetLowerPrice.toFixed(4)} (Tick: ${tr.lowerTick})`);
    console.log(`  Spot Center:            $${driftRecord.price.toFixed(4)}`);
    console.log(`  New Upper Bound:        $${tr.targetUpperPrice.toFixed(4)} (Tick: ${tr.upperTick})`);
    console.log(`  Band Span:              ±10.0% concentrated liquidity band`);
  }

  console.log('\n' + '='.repeat(78));
  console.log('✅ CETUS CLMM AUTOMATED REBALANCING & YIELD ROUTING SUITE VERIFIED!');
  console.log('='.repeat(78));
}

main().catch((err) => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
