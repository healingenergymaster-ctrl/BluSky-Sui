// scripts/test_onchain_flow.mjs
// Executes real on-chain deposit and split_share transactions on Sui Testnet

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const SUI_CLI = path.join(process.env.USERPROFILE || 'C:\\Users\\crypt', '.cargo', 'bin', 'sui.exe');

const PACKAGE_ID = '0x9012c6d5deddf25d936ffe5aeadc6849c9488223e7f81cb54f8faced78d23844';
const VAULT_ID = '0x630639ff9b39e8515ce648202a3d919d95ab421aa1f2f6903875964fed0708dc';
const SENDER = '0xc89ce5dfb92494b66bef0305b062d3fd84dcd4a247deccd5154f12a30f553ce4';
const COIN_A = '0x2::sui::SUI';
const COIN_B = '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC';

async function run() {
  console.log('=================================================================');
  console.log('🧪 BluSky-Sui — Live On-Chain Testnet PTB Execution');
  console.log('=================================================================\n');

  console.log(`📦 Published Package ID: ${PACKAGE_ID}`);
  console.log(`🏛️ Shared Vault Object:  ${VAULT_ID}`);
  console.log(`👛 Testnet Signer:        ${SENDER}\n`);

  // Ensure active environment is testnet
  try {
    execSync(`"${SUI_CLI}" client switch --env testnet`, { stdio: 'pipe' });
    execSync(`"${SUI_CLI}" client switch --address "${SENDER}"`, { stdio: 'pipe' });
  } catch (err) {
    console.warn('Environment switch warning:', err.message);
  }

  const activeAddr = execSync(`"${SUI_CLI}" client active-address`).toString().trim();
  console.log(`🟢 Verified Active Signer: ${activeAddr}`);

  // Build PTB:
  // 1. Split 0.1 SUI (100,000,000 MIST) from Gas
  // 2. Create 0-value USDC coin using 0x2::coin::zero
  // 3. Call blusky_vault::vault::deposit -> mints VaultShare (100,000,000 shares)
  // 4. Call blusky_vault::vault::split_share -> splits 25,000,000 shares (25%)
  // 5. Transfer both shares back to signer address
  console.log('\n🔨 Constructing Atomic PTB:');
  console.log('   Step 1: split-coins gas [100,000,000 MIST] (0.1 SUI)');
  console.log('   Step 2: move-call 0x2::coin::zero<USDC>');
  console.log('   Step 3: move-call vault::deposit<SUI, USDC> -> mints 100,000,000 VaultShares');
  console.log('   Step 4: move-call vault::split_share -> splits 25,000,000 VaultShares (25%)');
  console.log('   Step 5: transfer-objects [parent_share, child_share] -> recipient\n');

  const ptbCmd = [
    `"${SUI_CLI}" client ptb`,
    `--split-coins gas [100000000]`,
    `--assign sui_coin`,
    `--move-call 0x2::coin::zero "<${COIN_B}>"`,
    `--assign zero_usdc`,
    `--move-call ${PACKAGE_ID}::vault::deposit "<${COIN_A}, ${COIN_B}>" @${VAULT_ID} sui_coin.0 zero_usdc`,
    `--assign share`,
    `--move-call ${PACKAGE_ID}::vault::split_share "<${COIN_A}, ${COIN_B}>" share 25000000`,
    `--assign split_share`,
    `--transfer-objects "[share, split_share]" @${SENDER}`,
    `--gas-budget 50000000`,
    `--json`
  ].join(' ');

  console.log('🚀 Submitting Atomic PTB to Sui Testnet validators...');
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
    console.log(`🎉 ✅ ATOMIC TRANSACTION SUCCESSFUL (${elapsedMs}ms)!`);
    console.log(`=================================================================`);
    console.log(`• Tx Digest:   \x1b[32m${digest}\x1b[0m`);
    console.log(`• Gas Used:    ${Number(result.effects?.gasUsed?.computationCost || 0) / 1e9} SUI`);
    
    // Find created VaultShare objects
    const createdShares = [];
    result.objectChanges?.forEach(obj => {
      if (obj.objectType && obj.objectType.includes('::vault::VaultShare')) {
        createdShares.push(obj.objectId);
      }
    });

    console.log(`\n📜 Created On-Chain Vault LP Objects:`);
    createdShares.forEach((id, idx) => {
      console.log(`   ${idx === 0 ? 'Parent VaultShare (75%)' : 'Child VaultShare (25%)'}: \x1b[36m${id}\x1b[0m`);
    });

    console.log(`\n🌐 Block Explorer Links:`);
    console.log(`   👉 SuiVision Tx:   https://testnet.suivision.xyz/txblock/${digest}`);
    console.log(`   👉 Polymedia Tx:  https://explorer.polymedia.app/txblock/${digest}?network=testnet`);
    console.log(`   👉 Suiscan Tx:    https://suiscan.xyz/testnet/tx/${digest}`);
    console.log(`   👉 Vault Object:  https://testnet.suivision.xyz/object/${VAULT_ID}`);
    console.log(`=================================================================\n`);

    return { digest, createdShares };
  } catch (err) {
    console.error('\n❌ PTB Execution Error:', err.message);
    if (err.stdout) console.error('Stdout:', err.stdout.toString());
    if (err.stderr) console.error('Stderr:', err.stderr.toString());
    process.exit(1);
  }
}

run();

