// scripts/test_onchain_compound.mjs
// Executes real on-chain fee harvest, 10% treasury routing, and 90% auto-compounding on Sui Testnet

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SUI_CLI = path.join(process.env.USERPROFILE || 'C:\\Users\\crypt', '.cargo', 'bin', 'sui.exe');

const PACKAGE_ID = '0x9012c6d5deddf25d936ffe5aeadc6849c9488223e7f81cb54f8faced78d23844';
const VAULT_ID = '0x630639ff9b39e8515ce648202a3d919d95ab421aa1f2f6903875964fed0708dc';
const OPERATOR_CAP_ID = '0x2ba5abe25e4373e72b17c503c3033b83116735714ae4ab179ebd62b5fc64c6c6';
const TREASURY_ADDR = '0xa81ad397c3aadae2ddcfde5cef96aa21d4f445c918f8d819c5ea757aafa8f6db';
const SENDER = '0xc89ce5dfb92494b66bef0305b062d3fd84dcd4a247deccd5154f12a30f553ce4';
const COIN_A = '0x2::sui::SUI';
const COIN_B = '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC';

async function run() {
  console.log('=================================================================');
  console.log('🌾 BluSky-Sui — Live On-Chain Testnet Compounding & Fee Routing');
  console.log('=================================================================\n');

  console.log(`📦 Published Package ID: ${PACKAGE_ID}`);
  console.log(`🏛️ Shared Vault Object:  ${VAULT_ID}`);
  console.log(`🔑 OperatorCap ID:       ${OPERATOR_CAP_ID}`);
  console.log(`💰 Protocol Treasury:    ${TREASURY_ADDR}`);
  console.log(`👛 Testnet Signer:        ${SENDER}\n`);

  console.log('🔨 Constructing Compounding PTB:');
  console.log('   Step 1: split-coins gas [10,000,000 MIST] (0.01 SUI fee harvest)');
  console.log('   Step 2: move-call 0x2::coin::zero<USDC>');
  console.log('   Step 3: move-call vault::harvest_and_compound<SUI, USDC>(OperatorCap, Vault, FeeA, FeeB)');
  console.log('           -> 10% performance fee (0.001 SUI) routed directly to Protocol Treasury');
  console.log('           -> 90% (0.009 SUI) auto-compounded into Vault NAV\n');

  const ptbCmd = [
    `"${SUI_CLI}" client ptb`,
    `--split-coins gas [10000000]`,
    `--assign fee_a`,
    `--move-call 0x2::coin::zero "<${COIN_B}>"`,
    `--assign fee_b`,
    `--move-call ${PACKAGE_ID}::vault::harvest_and_compound "<${COIN_A}, ${COIN_B}>" @${OPERATOR_CAP_ID} @${VAULT_ID} fee_a.0 fee_b`,
    `--gas-budget 50000000`,
    `--json`
  ].join(' ');

  console.log('🚀 Submitting Compounding PTB to Sui Testnet validators...');
  const startTime = Date.now();

  try {
    const rawResult = execSync(ptbCmd, { maxBuffer: 10 * 1024 * 1024 }).toString();
    const result = JSON.parse(rawResult);
    const elapsedMs = Date.now() - startTime;

    const digest = result.digest;
    const status = result.effects?.status?.status;

    if (status !== 'success') {
      console.error(`\n❌ Transaction Failed! Status:`, result.effects?.status);
      process.exit(1);
    }

    console.log(`\n=================================================================`);
    console.log(`🎉 ✅ HARVEST & COMPOUNDING SUCCESSFUL (${elapsedMs}ms)!`);
    console.log(`=================================================================`);
    console.log(`• Tx Digest:   \x1b[32m${digest}\x1b[0m`);
    console.log(`• Gas Used:    ${Number(result.effects?.gasUsed?.computationCost || 0) / 1e9} SUI`);
    console.log(`• Treasury:    Received 10% performance fee cut at ${TREASURY_ADDR}`);
    console.log(`• Vault NAV:   Compounded 90% directly into liquidity reserves`);

    console.log(`\n🌐 Block Explorer Links:`);
    console.log(`   👉 SuiVision Tx:   https://testnet.suivision.xyz/txblock/${digest}`);
    console.log(`   👉 Polymedia Tx:  https://explorer.polymedia.app/txblock/${digest}?network=testnet`);
    console.log(`   👉 Suiscan Tx:    https://suiscan.xyz/testnet/tx/${digest}`);
    console.log(`   👉 Treasury View: https://testnet.suivision.xyz/account/${TREASURY_ADDR}`);
    console.log(`=================================================================\n`);

    return { digest };
  } catch (err) {
    console.error('\n❌ Compounding PTB Execution Error:', err.message);
    if (err.stdout) console.error('Stdout:', err.stdout.toString());
    if (err.stderr) console.error('Stderr:', err.stderr.toString());
    process.exit(1);
  }
}

run();

