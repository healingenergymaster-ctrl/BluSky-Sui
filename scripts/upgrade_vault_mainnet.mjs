// scripts/upgrade_vault_mainnet.mjs
// Upgrades the deployed blusky_vault Move package on Sui Mainnet in-place via UpgradeCap,
// preserving existing Vault & VaultShare state while adding active-LP deposit/withdraw functions.

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Transaction } from '@mysten/sui/transactions';
import { WalletManager } from '../src/services/wallet.mjs';
import { CetusService } from '../src/services/cetus.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const envPath = path.join(rootDir, '.env');
const publishedTomlPath = path.join(rootDir, 'move', 'Published.toml');

dotenv.config({ path: envPath, override: true });

function getSuiCli() {
  const candidates = [
    'sui',
    path.join(process.env.USERPROFILE || 'C:\\Users\\crypt', '.cargo', 'bin', 'sui.exe')
  ];
  for (const c of candidates) {
    try {
      execSync(`"${c}" --version`, { stdio: 'pipe' });
      return c;
    } catch (_) {}
  }
  throw new Error('Sui CLI binary not found');
}

function upsertEnvVars(updates) {
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  for (const [key, val] of Object.entries(updates)) {
    const line = `${key}=${val}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(content)) {
      content = content.replace(re, line);
    } else {
      if (content && !content.endsWith('\n')) content += '\n';
      content += `${line}\n`;
    }
  }
  fs.writeFileSync(envPath, content, 'utf8');
}

function updatePublishedMainnet(newPackageId) {
  if (!fs.existsSync(publishedTomlPath)) return;
  let toml = fs.readFileSync(publishedTomlPath, 'utf8');
  const secIdx = toml.indexOf('[published.mainnet]');
  if (secIdx === -1) return;
  const head = toml.slice(0, secIdx);
  let tail = toml.slice(secIdx);
  tail = tail.replace(/published-at = "[^"]+"/, `published-at = "${newPackageId}"`);
  tail = tail.replace(/version = \d+/, 'version = 2');
  fs.writeFileSync(publishedTomlPath, head + tail, 'utf8');
}

async function main() {
  const wallet = new WalletManager(process.env.SUI_PRIVATE_KEY);
  if (!wallet.isConfigured()) throw new Error('SUI_PRIVATE_KEY not configured in .env');

  const keypair = wallet.getKeypair();
  const sender = wallet.getAddress();
  const cetusService = new CetusService('mainnet');
  const grpcClient = cetusService.getGrpcClient();

  const currentPkg = process.env.VAULT_CALL_PACKAGE_ID || process.env.VAULT_PACKAGE_ID;
  const upgradeCapId = process.env.VAULT_UPGRADE_CAP;
  if (!currentPkg || !upgradeCapId) {
    throw new Error('VAULT_PACKAGE_ID and VAULT_UPGRADE_CAP must be set in .env');
  }

  console.log(`🔨 Compiling blusky_vault v3 bytecode...`);
  const suiCli = getSuiCli();
  const buildOut = execSync(`"${suiCli}" move build --dump-bytecode-as-base64 --path move`, {
    cwd: rootDir,
    encoding: 'utf8'
  });
  const jsonLine = buildOut.slice(buildOut.lastIndexOf('{"modules":'));
  const compiled = JSON.parse(jsonLine);

  console.log(`🚀 Upgrading Mainnet package ${currentPkg} using UpgradeCap ${upgradeCapId}...`);
  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasBudget(250_000_000);

  const [ticket] = tx.moveCall({
    target: '0x2::package::authorize_upgrade',
    arguments: [
      tx.object(upgradeCapId),
      tx.pure.u8(0), // UpgradePolicy::COMPATIBLE
      tx.pure.vector('u8', compiled.digest)
    ]
  });

  const receipt = tx.upgrade({
    modules: compiled.modules,
    dependencies: compiled.dependencies,
    package: currentPkg,
    ticket
  });

  tx.moveCall({
    target: '0x2::package::commit_upgrade',
    arguments: [tx.object(upgradeCapId), receipt]
  });

  const res = await grpcClient.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    include: { effects: true, objectTypes: true }
  });

  const txObj = res.$kind === 'Transaction' ? res.Transaction : res.FailedTransaction;
  if (res.$kind === 'FailedTransaction' || !txObj?.status?.success) {
    throw new Error(`Upgrade failed (digest=${txObj?.digest}): ${JSON.stringify(txObj?.status?.error || res)}`);
  }

  await grpcClient.waitForTransaction({ digest: txObj.digest });

  const pkgChange = (txObj.effects?.changedObjects || []).find(
    (c) => c.idOperation === 'Created' && c.outputState === 'PackageWrite'
  );
  const newPackageId = pkgChange?.objectId;
  if (!newPackageId) {
    throw new Error('Upgrade succeeded on-chain, but could not parse new Package ID from effects');
  }

  upsertEnvVars({ VAULT_CALL_PACKAGE_ID: newPackageId });
  updatePublishedMainnet(newPackageId);

  console.log(`✅ Upgrade Complete!`);
  console.log(`   Digest:               ${txObj.digest}`);
  console.log(`   Original Type Pkg:    ${process.env.VAULT_PACKAGE_ID}`);
  console.log(`   Upgraded Call Pkg:    ${newPackageId}`);
}

main().catch((err) => {
  console.error('❌ Mainnet upgrade error:', err.message);
  process.exit(1);
});

