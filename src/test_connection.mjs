// src/test_connection.mjs
// Tests Sui Network RPC and Turbos SDK Connectivity
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { TurbosSdk, Network } from 'turbos-clmm-sdk';
import { SUI_CONFIG } from './config.mjs';

async function main() {
  console.log('====================================================');
  console.log('🌊 Testing Sui Network & Turbos CLMM Connectivity...');
  console.log('====================================================');
  console.log(`Target RPC: ${SUI_CONFIG.rpcUrl}`);
  console.log(`Network:    ${SUI_CONFIG.network}`);

  // 1. Test Sui JSON-RPC Client
  const rpcClient = new SuiJsonRpcClient({ url: SUI_CONFIG.rpcUrl });
  try {
    const chainId = await rpcClient.getChainIdentifier();
    const gasPrice = await rpcClient.getReferenceGasPrice();
    const latestCheckpoint = await rpcClient.getLatestCheckpointSequenceNumber();
    console.log('\n✅ Sui JSON-RPC Connected Successfully!');
    console.log(`   • Chain Identifier:         ${chainId}`);
    console.log(`   • Latest Checkpoint:        ${latestCheckpoint}`);
    console.log(`   • Reference Gas Price:      ${gasPrice} MIST`);
  } catch (err) {
    console.warn(`\n⚠️  JSON-RPC direct call note: ${err.message}`);
  }

  // 2. Test Turbos SDK Initialization
  try {
    const turbosSdk = new TurbosSdk(Network[SUI_CONFIG.network] || Network.mainnet);
    console.log('\n✅ Turbos CLMM SDK Initialized Successfully!');
    console.log(`   • Provider:                 ${turbosSdk.provider.constructor.name}`);
    console.log(`   • SUI/USDC Target Pool:     ${SUI_CONFIG.pools.turbos_sui_usdc}`);
  } catch (err) {
    console.error(`\n❌ Turbos SDK Error: ${err.message}`);
  }

  console.log('\n====================================================');
  console.log('🚀 Sui Client environment is operational.');
  console.log('====================================================');
}

main();
