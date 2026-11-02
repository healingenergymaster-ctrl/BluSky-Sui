// src/services/vaultContract.mjs
// Move Contract Interoperability & PTB Builder for BluSky-Sui Vaults

import { Transaction } from '@mysten/sui/transactions';
import { SUI_CONFIG } from '../config.mjs';

export const VAULT_PACKAGE_CONFIG = {
  // Move package address (published package ID on mainnet/testnet)
  packageId: process.env.BLUSKY_VAULT_PACKAGE_ID || '0x_blusky_vault_package_id',
  moduleName: 'vault',
  defaultFeeTreasury: process.env.FEE_TREASURY_ADDRESS || '0x_protocol_fee_treasury_address',
  defaultPerformanceFeeBps: 1000 // 10.0%
};

export class VaultContractService {
  constructor(options = {}) {
    this.packageId = options.packageId || VAULT_PACKAGE_CONFIG.packageId;
    this.rpcClient = options.rpcClient || null;
    this.coinTypeA = options.coinTypeA || SUI_CONFIG.coins.SUI;
    this.coinTypeB = options.coinTypeB || SUI_CONFIG.coins.USDC;
  }

  /**
   * Constructs a PTB to deploy a new shared non-custodial vault.
   * @param {number} feeRateBps e.g. 1000 for 10%
   * @param {string} feeTreasury Protocol fee recipient address
   */
  buildCreateVaultTx(feeRateBps = VAULT_PACKAGE_CONFIG.defaultPerformanceFeeBps, feeTreasury = VAULT_PACKAGE_CONFIG.defaultFeeTreasury) {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::vault::create_vault`,
      typeArguments: [this.coinTypeA, this.coinTypeB],
      arguments: [
        tx.pure.u64(feeRateBps),
        tx.pure.address(feeTreasury)
      ]
    });
    return tx;
  }

  /**
   * Constructs a PTB for user deposit into the vault.
   * @param {string} vaultId Shared Vault object ID
   * @param {Object} coinAArg Sui transaction coin object for CoinA
   * @param {Object} coinBArg Sui transaction coin object for CoinB
   * @param {string} recipient User address to receive the VaultShare NFT
   */
  buildDepositTx({ vaultId, coinAArg, coinBArg, recipient }) {
    const tx = new Transaction();
    const shareObj = tx.moveCall({
      target: `${this.packageId}::vault::deposit`,
      typeArguments: [this.coinTypeA, this.coinTypeB],
      arguments: [
        tx.object(vaultId),
        coinAArg,
        coinBArg
      ]
    });

    // Transfer the newly minted transferable VaultShare to the depositor
    tx.transferObjects([shareObj], tx.pure.address(recipient));
    return tx;
  }

  /**
   * Constructs a PTB for user share redemption.
   * @param {string} vaultId 
   * @param {string} shareId VaultShare object ID to redeem
   * @param {string} recipient 
   */
  buildWithdrawTx({ vaultId, shareId, recipient }) {
    const tx = new Transaction();
    const [coinA, coinB] = tx.moveCall({
      target: `${this.packageId}::vault::withdraw`,
      typeArguments: [this.coinTypeA, this.coinTypeB],
      arguments: [
        tx.object(vaultId),
        tx.object(shareId)
      ]
    });

    tx.transferObjects([coinA, coinB], tx.pure.address(recipient));
    return tx;
  }

  /**
   * Constructs an operator PTB to deduct 10% performance fee and auto-compound the remaining 90%.
   * @param {string} operatorCapId OperatorCap object ID
   * @param {string} vaultId Shared Vault object ID
   * @param {Object} feeCoinAArg 
   * @param {Object} feeCoinBArg 
   */
  buildHarvestAndCompoundTx({ operatorCapId, vaultId, feeCoinAArg, feeCoinBArg }) {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::vault::harvest_and_compound`,
      typeArguments: [this.coinTypeA, this.coinTypeB],
      arguments: [
        tx.object(operatorCapId),
        tx.object(vaultId),
        feeCoinAArg,
        feeCoinBArg
      ]
    });
    return tx;
  }

  /**
   * Retrieves on-chain vault metrics (or calibrated simulation in DRY_RUN).
   * @param {string} vaultId 
   * @param {number} currentPrice SUI spot price
   */
  async getVaultMetrics(vaultId = '0x_simulated_blusky_vault', currentPrice = 2.05) {
    // Calibrated simulation for $20,000 pilot vault
    const totalShares = 20000;
    const balanceA_Sui = 4878; // ~$10,000 SUI
    const balanceB_Usdc = 10000; // $10,000 USDC
    const feeRateBps = 1000; // 10%

    const totalValUsd = balanceA_Sui * currentPrice + balanceB_Usdc;
    const sharePriceUsd = totalValUsd / totalShares;

    return {
      vaultId,
      packageId: this.packageId,
      coinTypeA: this.coinTypeA,
      coinTypeB: this.coinTypeB,
      totalShares,
      balanceA_Sui,
      balanceB_Usdc,
      totalValUsd: Math.round(totalValUsd * 100) / 100,
      sharePriceUsd: Math.round(sharePriceUsd * 10000) / 10000,
      performanceFeePct: feeRateBps / 100,
      isSimulated: true
    };
  }
}

export const defaultVaultContractService = new VaultContractService();
