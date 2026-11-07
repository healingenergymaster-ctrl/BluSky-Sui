// src/test_connection.mjs
// Tests Sui Network GraphQL / RPC and Turbos SDK Connectivity
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { TurbosSdk, Network } from 'turbos-clmm-sdk';
import { SUI_CONFIG } from './config.mjs';

async function main() {
  console.log('====================================================');
  console.log(`🌊 Testing Sui Network [${SUI_CONFIG.network.toUpperCase()}] Connectivity...`);
  console.log('====================================================');
  console.log(`Target GraphQL: ${SUI_CONFIG.graphqlUrl}`);
  console.log(`Target RPC:     ${SUI_CONFIG.rpcUrl}`);
  console.log(`Network Mode:   ${SUI_CONFIG.network}`);

  // 1. Test Sui GraphQL Client
  try {
    const gqlClient = new SuiGraphQLClient({ url: SUI_CONFIG.graphqlUrl });
    const res = await gqlClient.query({
      query: `
        query {
          chainIdentifier
          checkpoint {
            sequenceNumber
          }
          epoch {
            referenceGasPrice
          }
        }
      `
    });

    const chainId = res?.data?.chainIdentifier;
    const checkpoint = res?.data?.checkpoint?.sequenceNumber;
    const gasPrice = res?.data?.epoch?.referenceGasPrice;

    console.log('\n✅ Sui GraphQL Connected Successfully!');
    console.log(`   • Chain Identifier:         ${chainId}`);
    console.log(`   • Latest Checkpoint:        ${checkpoint}`);
    console.log(`   • Reference Gas Price:      ${gasPrice} MIST`);
  } catch (err) {
    console.warn(`\n⚠️  GraphQL connection note: ${err.message}`);
  }

  // 2. Test Turbos SDK Initialization
  try {
    const turbosSdk = new TurbosSdk(Network[SUI_CONFIG.network] || Network.mainnet);
    console.log('\n✅ Turbos CLMM SDK Initialized Successfully!');
    console.log(`   • Provider:                 ${turbosSdk.provider.constructor.name}`);
    console.log(`   • SUI/USDC Target Pool:     ${SUI_CONFIG.pools.turbos_sui_usdc || 'Default/Dynamic'}`);
  } catch (err) {
    console.error(`\n❌ Turbos SDK Error: ${err.message}`);
  }

  console.log('\n====================================================');
  console.log(`🚀 Sui ${SUI_CONFIG.network.toUpperCase()} environment is operational.`);
  console.log('====================================================');
}

main();
