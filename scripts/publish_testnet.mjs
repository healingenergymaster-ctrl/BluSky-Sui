// scripts/publish_testnet.mjs
// Compiles and publishes BluSky-Sui Move package to Sui Testnet,
// captures packageId, UpgradeCap, and initial Vault shared object.

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const moveDir = path.join(rootDir, 'move');
const envTestnetPath = path.join(rootDir, '.env.testnet');

// Find sui binary
function getSuiCli() {
  const candidates = [
    'sui',
    path.join(process.env.USERPROFILE || 'C:\\Users\\crypt', '.cargo', 'bin', 'sui.exe'),
    path.join(rootDir, 'bin', 'sui.exe'),
    'C:\\sui\\sui.exe'
  ];
  for (const c of candidates) {
    try {
      execSync(`"${c}" --version`, { stdio: 'pipe' });
      return c;
    } catch (_) {}
  }
  return null;
}

async function publish() {
  console.log('=================================================================');
  console.log('🚀 BluSky-Sui — Sui Testnet Move Package Publisher');
  console.log('=================================================================\n');

  const suiCli = getSuiCli();
  if (!suiCli) {
    throw new Error('Sui CLI binary not found. Please wait for download/install to complete.');
  }

  const cliVersion = execSync(`"${suiCli}" --version`).toString().trim();
  console.log(`🛠️ Sui CLI: ${cliVersion}`);

  // 1. Read Testnet credentials from .env.testnet
  if (!fs.existsSync(envTestnetPath)) {
    throw new Error('.env.testnet not found! Run npm run testnet:wallet first.');
  }
  const envContent = fs.readFileSync(envTestnetPath, 'utf8');
  const privKeyMatch = envContent.match(/SUI_PRIVATE_KEY=["']?([^"'\r\n]+)["']?/);
  if (!privKeyMatch || !privKeyMatch[1]) {
    throw new Error('SUI_PRIVATE_KEY not found in .env.testnet');
  }
  const privKey = privKeyMatch[1].trim();

  // 2. Configure Sui client environment for Testnet
  console.log('\n🌐 1. Configuring Sui Client Testnet Environment...');
  try {
    execSync(`"${suiCli}" client new-env --alias testnet --rpc https://fullnode.testnet.sui.io:443`, { stdio: 'pipe' });
  } catch (_) {}
  execSync(`"${suiCli}" client switch --env testnet`, { stdio: 'inherit' });

  // 3. Import key if not already active and switch
  console.log('\n🔑 2. Ensuring active keypair is set to dedicated Testnet wallet...');
  const keypair = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(privKey).secretKey);
  const targetAddr = keypair.toSuiAddress();
  try {
    execSync(`"${suiCli}" keytool import "${privKey}" ed25519`, { stdio: 'pipe' });
  } catch (_) {}
  try {
    execSync(`"${suiCli}" client switch --address "${targetAddr}"`, { stdio: 'pipe' });
  } catch (_) {}

  const activeAddr = execSync(`"${suiCli}" client active-address`).toString().trim();
  console.log(`   Active Signer Address: \x1b[32m${activeAddr}\x1b[0m`);

  // 4. Build and type-check Move package
  console.log('\n📦 3. Compiling Move Package (move/sources)...');
  execSync(`"${suiCli}" move build --path "${moveDir}"`, { stdio: 'inherit' });
  console.log('   ✅ Move bytecode compiled and verified successfully!');

  // 5. Publish to Testnet
  console.log('\n🚀 4. Publishing Package to Sui Testnet via PTB...');
  const publishCmd = `"${suiCli}" client publish --gas-budget 200000000 --json "${moveDir}"`;
  const rawOutput = execSync(publishCmd).toString();
  const result = JSON.parse(rawOutput);

  if (result.effects?.status?.status !== 'success') {
    console.error('❌ Publish failed:', result.effects?.status);
    process.exit(1);
  }

  const txDigest = result.digest;
  console.log(`\n🎉 Package Published Successfully!`);
  console.log(`   Tx Digest: https://suiscan.xyz/testnet/tx/${txDigest}`);

  // Find published package ID and UpgradeCap
  let packageId = null;
  let upgradeCapId = null;

  result.objectChanges?.forEach(obj => {
    if (obj.type === 'published') {
      packageId = obj.packageId;
    } else if (obj.objectType && obj.objectType.includes('::package::UpgradeCap')) {
      upgradeCapId = obj.objectId;
    }
  });

  console.log(`\n=================================================================`);
  console.log(`📦 Published Package ID: \x1b[36m${packageId}\x1b[0m`);
  console.log(`🛡️ UpgradeCap ID:        \x1b[33m${upgradeCapId}\x1b[0m`);
  console.log(`=================================================================\n`);

  // 6. Append package ID to .env.testnet and .env
  let updatedEnv = envContent;
  if (updatedEnv.includes('VAULT_PACKAGE_ID=')) {
    updatedEnv = updatedEnv.replace(/VAULT_PACKAGE_ID=.*(\r?\n|$)/, `VAULT_PACKAGE_ID=${packageId}\n`);
  } else {
    updatedEnv += `\n# Published Move Package ID\nVAULT_PACKAGE_ID=${packageId}\nVAULT_UPGRADE_CAP=${upgradeCapId}\n`;
  }
  fs.writeFileSync(envTestnetPath, updatedEnv, 'utf8');
  console.log(`📁 Saved VAULT_PACKAGE_ID=${packageId} to .env.testnet`);

  return { packageId, upgradeCapId, txDigest };
}

publish().catch(err => {
  console.error('\n❌ Publish Script Error:', err.message);
  process.exit(1);
});

