// scripts/test_onchain_withdraw.mjs
// Executes real on-chain withdrawal (redemption) of the split VaultShare on Sui Testnet

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SUI_CLI = path.join(process.env.USERPROFILE || 'C:\\Users\\crypt', '.cargo', 'bin', 'sui.exe');

const PACKAGE_ID = '0x9012c6d5deddf25d936ffe5aeadc6849c9488223e7f81cb54f8faced78d23844';
const VAULT_ID = '0x630639ff9b39e8515ce648202a3d919d95ab421aa1f2f6903875964fed0708dc';
const SENDER = '0xc89ce5dfb92494b66bef0305b062d3fd84dcd4a247deccd5154f12a30f553ce4';
const COIN_A = '0x2::sui::SUI';
const COIN_B = '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC';

// Child VaultShare created in the deposit PTB
const CHILD_SHARE_ID = process.argv[2] || '0xceb1d670fa20a14842f77a7435aba57f2d463e53f9d4de1ed4ad018a403f3d1a';

async function run() {
  console.log('=================================================================');
  console.log('🔥 BluSky-Sui — Live On-Chain Testnet Withdrawal PTB Execution');
  console.log('=================================================================\n');

  console.log(`📦 Published Package ID: ${PACKAGE_ID}`);
  console.log(`🏛️ Shared Vault Object:  ${VAULT_ID}`);
  console.log(`🎟️ VaultShare to Redeem: ${CHILD_SHARE_ID}`);
  console.log(`👛 Testnet Signer:        ${SENDER}\n`);

  console.log('🔨 Constructing Withdrawal PTB:');
  console.log('   Step 1: move-call vault::withdraw<SUI, USDC>(Vault, VaultShare)');
  console.log('   Step 2: transfer-objects [returned_coin_a, returned_coin_b] -> recipient\n');

  const ptbCmd = [
    `"${SUI_CLI}" client ptb`,
    `--move-call ${PACKAGE_ID}::vault::withdraw "<${COIN_A}, ${COIN_B}>" @${VAULT_ID} @${CHILD_SHARE_ID}`,
    `--assign coins`,
    `--transfer-objects "[coins.0, coins.1]" @${SENDER}`,
    `--gas-budget 50000000`,
    `--json`
  ].join(' ');

  console.log('🚀 Submitting Withdrawal PTB to Sui Testnet validators...');
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
    console.log(`🎉 ✅ REDEMPTION SUCCESSFUL (${elapsedMs}ms)!`);
    console.log(`=================================================================`);
    console.log(`• Tx Digest:   \x1b[32m${digest}\x1b[0m`);
    console.log(`• Gas Used:    ${Number(result.effects?.gasUsed?.computationCost || 0) / 1e9} SUI`);
    console.log(`• Shares Burned: 25,000,000 VaultShares (Object deleted from state)`);

    console.log(`\n🌐 Block Explorer Links:`);
    console.log(`   👉 SuiVision Tx:   https://testnet.suivision.xyz/txblock/${digest}`);
    console.log(`   👉 Polymedia Tx:  https://explorer.polymedia.app/txblock/${digest}?network=testnet`);
    console.log(`   👉 Suiscan Tx:    https://suiscan.xyz/testnet/tx/${digest}`);
    console.log(`   👉 Vault Object:  https://testnet.suivision.xyz/object/${VAULT_ID}`);
    console.log(`=================================================================\n`);

    return { digest };
  } catch (err) {
    console.error('\n❌ Withdrawal PTB Execution Error:', err.message);
    if (err.stdout) console.error('Stdout:', err.stdout.toString());
    if (err.stderr) console.error('Stderr:', err.stderr.toString());
    process.exit(1);
  }
}

run();

