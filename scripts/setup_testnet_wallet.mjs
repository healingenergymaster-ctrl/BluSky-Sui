// scripts/setup_testnet_wallet.mjs
// Generates or retrieves a dedicated Sui Testnet wallet for BluSky-Sui testing,
// displays public address, importable private key, balance, and faucet instructions.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const envTestnetPath = path.join(rootDir, '.env.testnet');

const TESTNET_GRAPHQL = 'https://graphql.testnet.sui.io/graphql';

async function main() {
  console.log('=================================================================');
  console.log('💧 BluSky-Sui — Testnet Configuration & Wallet Setup');
  console.log('=================================================================\n');

  let keypair;
  let isNew = false;
  let savedPrivKey = '';

  // Check if .env.testnet already has a private key
  if (fs.existsSync(envTestnetPath)) {
    const content = fs.readFileSync(envTestnetPath, 'utf8');
    const match = content.match(/SUI_PRIVATE_KEY=["']?([^"'\r\n]+)["']?/);
    if (match && match[1] && match[1].trim() !== '') {
      savedPrivKey = match[1].trim();
      try {
        if (savedPrivKey.startsWith('suiprivkey')) {
          const decoded = decodeSuiPrivateKey(savedPrivKey);
          keypair = Ed25519Keypair.fromSecretKey(decoded.secretKey);
        } else {
          const hex = savedPrivKey.startsWith('0x') ? savedPrivKey.slice(2) : savedPrivKey;
          keypair = Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(hex, 'hex')));
        }
      } catch (err) {
        console.warn(`⚠️ Could not parse existing SUI_PRIVATE_KEY in .env.testnet (${err.message}). Generating new one.`);
        keypair = null;
      }
    }
  }

  if (!keypair) {
    keypair = new Ed25519Keypair();
    isNew = true;
    savedPrivKey = keypair.getSecretKey(); // suiprivkey... format
  }

  const suiAddress = keypair.toSuiAddress();

  // Create or update .env.testnet
  const envTestnetContent = `# BluSky-Sui Testnet Environment
SUI_NETWORK=testnet
SUI_RPC_URL=https://fullnode.testnet.sui.io:443
SUI_GRAPHQL_URL=https://graphql.testnet.sui.io/graphql

# Bot Execution Mode
EXECUTION_MODE=DRY_RUN

# Protocol Fee Treasury Recipient Address
FEE_TREASURY_ADDRESS=0xa81ad397c3aadae2ddcfde5cef96aa21d4f445c918f8d819c5ea757aafa8f6db

# Dedicated Testnet Wallet Private Key
SUI_PRIVATE_KEY=${savedPrivKey}

# Target Pools (Testnet)
TURBOS_SUI_USDC_POOL=
BLUEFIN_SUI_USDC_POOL=

# Rebalancing Parameters
DRIFT_THRESHOLD_PCT=15
TARGET_BAND_WIDTH_PCT=10
MIN_FEES_BEFORE_REBALANCE_USD=5.0
MAX_COST_TO_FEE_RATIO=0.20
MAX_SLIPPAGE_PCT=0.5
CHECK_INTERVAL_MS=30000

# Hedging Parameters
HEDGING_ENABLED=false
`;

  fs.writeFileSync(envTestnetPath, envTestnetContent, 'utf8');

  console.log(isNew ? '🔑 [New Keypair Generated]' : '🔑 [Loaded Existing Testnet Keypair]');
  console.log(`\n📌 Testnet Wallet Address:`);
  console.log(`   👉 \x1b[32m${suiAddress}\x1b[0m\n`);
  console.log(`🔐 Exportable Private Key (for browser wallet import):`);
  console.log(`   👉 \x1b[33m${savedPrivKey}\x1b[0m\n`);
  console.log(`📁 Saved to: ${envTestnetPath}\n`);

  // Check balance on Sui Testnet via GraphQL
  console.log('🔍 Checking live balance on Sui Testnet...');
  let totalBalanceMist = 0n;
  try {
    const gqlClient = new SuiGraphQLClient({ url: TESTNET_GRAPHQL });
    const query = `
      query getBalance($address: SuiAddress!) {
        address(address: $address) {
          balance(coinType: "0x2::sui::SUI") {
            totalBalance
          }
        }
      }
    `;
    const res = await gqlClient.query({
      query,
      variables: { address: suiAddress }
    });

    const balanceData = res?.data?.address?.balance;
    if (balanceData && balanceData.totalBalance) {
      totalBalanceMist = BigInt(balanceData.totalBalance);
    }
    const suiBalance = (Number(totalBalanceMist) / 1e9).toFixed(4);
    console.log(`💰 Current SUI Balance: \x1b[32m${suiBalance} SUI\x1b[0m (${totalBalanceMist.toString()} MIST)\n`);

    if (totalBalanceMist === 0n) {
      console.log('=================================================================');
      console.log('🚰 HOW TO GET FREE TESTNET SUI:');
      console.log('=================================================================');
      console.log('1. Official Web Faucet (Instant):');
      console.log('   🔗 https://faucet.sui.io');
      console.log(`   Paste address: ${suiAddress}`);
      console.log('\n2. Via Browser Wallet (Sui Wallet, Slingshot, Suiet, or Nightly):');
      console.log('   - Import the private key above');
      console.log('   - Switch network to "Testnet"');
      console.log('   - Click "Request Testnet SUI"');
      console.log('\n3. Official Sui Discord:');
      console.log('   Join https://discord.gg/sui -> #testnet-faucet channel');
      console.log(`   Send: !faucet ${suiAddress}`);
      console.log('=================================================================\n');
    } else {
      console.log('🎉 ✅ Wallet is funded and ready for Testnet transactions!');
    }
  } catch (err) {
    console.warn(`⚠️ Could not query balance from GraphQL: ${err.message}`);
  }
}

main();
