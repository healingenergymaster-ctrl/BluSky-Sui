// src/services/wallet.mjs
// Sui Wallet & Signer Management

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { SUI_CONFIG } from '../config.mjs';

export class WalletManager {
  constructor(privateKey = SUI_CONFIG.privateKey) {
    this.keypair = null;
    this.isEphemeral = false;
    this._initialize(privateKey);
  }

  _initialize(rawKey) {
    if (!rawKey || rawKey === 'your_private_key_here' || rawKey.trim() === '') {
      // Ephemeral mock key for read-only / simulation mode
      this.keypair = new Ed25519Keypair();
      this.isEphemeral = true;
      return;
    }

    const key = rawKey.trim();

    try {
      if (key.startsWith('suiprivkey')) {
        const decoded = decodeSuiPrivateKey(key);
        this.keypair = Ed25519Keypair.fromSecretKey(decoded.secretKey);
      } else {
        // Assume hex string (strip 0x if present)
        const hex = key.startsWith('0x') ? key.slice(2) : key;
        const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
        this.keypair = Ed25519Keypair.fromSecretKey(bytes);
      }
      this.isEphemeral = false;
    } catch (err) {
      console.warn(`[Wallet] Failed to parse provided SUI_PRIVATE_KEY: ${err.message}. Using ephemeral keypair.`);
      this.keypair = new Ed25519Keypair();
      this.isEphemeral = true;
    }
  }

  getKeypair() {
    return this.keypair;
  }

  getAddress() {
    return this.keypair.toSuiAddress();
  }

  isConfigured() {
    return !this.isEphemeral;
  }
}

export const defaultWallet = new WalletManager();
