// scripts/install_sui_cli.mjs
// Downloads official MystenLabs Sui CLI binary for Windows and installs it to .cargo/bin

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const DOWNLOAD_URL = 'https://github.com/MystenLabs/sui/releases/download/testnet-v1.83.1/sui-testnet-v1.83.1-windows-x86_64.tgz';
const CARGO_BIN = path.join(process.env.USERPROFILE || 'C:\\Users\\crypt', '.cargo', 'bin');
const TEMP_TGZ = path.join(process.env.TEMP || '.', 'sui-testnet.tgz');
const TEMP_EXTRACT = path.join(process.env.TEMP || '.', 'sui-extract');

async function install() {
  console.log('====================================================');
  console.log('⬇️ Downloading Official MystenLabs Sui Testnet CLI...');
  console.log(`URL: ${DOWNLOAD_URL}`);
  console.log('====================================================');

  const res = await fetch(DOWNLOAD_URL);
  if (!res.ok) {
    throw new Error(`Failed to download: HTTP ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  fs.writeFileSync(TEMP_TGZ, Buffer.from(arrayBuffer));
  console.log(`✅ Download complete: ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);

  if (!fs.existsSync(TEMP_EXTRACT)) {
    fs.mkdirSync(TEMP_EXTRACT, { recursive: true });
  }

  console.log('📦 Extracting sui.exe via tar...');
  execSync(`tar -xzf "${TEMP_TGZ}" -C "${TEMP_EXTRACT}"`);

  // Locate sui.exe in extracted contents
  function findFile(dir, name) {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) {
        const found = findFile(full, name);
        if (found) return found;
      } else if (f.toLowerCase() === name.toLowerCase()) {
        return full;
      }
    }
    return null;
  }

  const suiExe = findFile(TEMP_EXTRACT, 'sui.exe');
  if (!suiExe) {
    throw new Error('sui.exe not found in extracted archive!');
  }

  const targetPath = path.join(CARGO_BIN, 'sui.exe');
  console.log(`🚚 Installing sui.exe to: ${targetPath}`);
  fs.copyFileSync(suiExe, targetPath);

  // Clean up temp
  try {
    fs.unlinkSync(TEMP_TGZ);
    fs.rmSync(TEMP_EXTRACT, { recursive: true, force: true });
  } catch (_) {}

  console.log('\n🎉 Sui CLI installed successfully!');
  const version = execSync(`"${targetPath}" --version`).toString();
  console.log(`Version: ${version.trim()}`);
}

install().catch(console.error);

