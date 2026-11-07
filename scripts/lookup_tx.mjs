// scripts/lookup_tx.mjs
// Inspects a transaction digest on Sui Testnet via GraphQL

import { SuiGraphQLClient } from '@mysten/sui/graphql';

const digest = process.argv[2] || 'GNKXHLUKMDdfJ3KkvrL6aHJGT9q8eXaVEFijDfh4TneT';

async function check() {
  console.log(`🔍 Querying Sui Testnet for digest: ${digest}...`);
  const client = new SuiGraphQLClient({ url: 'https://graphql.testnet.sui.io/graphql' });
  const txRes = await client.query({
    query: `
      query getTx($digest: String!) {
        transaction(digest: $digest) {
          digest
          sender {
            address
          }
          effects {
            status
            timestamp
            balanceChanges {
              nodes {
                coinType {
                  repr
                }
                owner {
                  address
                }
                amount
              }
            }
          }
        }
      }
    `,
    variables: { digest }
  });

  const tx = txRes.data?.transaction;
  if (!tx) {
    console.error('❌ Transaction not found or pending indexing.');
    return;
  }

  console.log('\n====================================================');
  console.log('✅ Transaction Verified on Sui Testnet');
  console.log('====================================================');
  console.log(`• Status:       ${tx.effects?.status}`);
  console.log(`• Timestamp:    ${tx.effects?.timestamp}`);
  console.log(`• Sender:       ${tx.sender?.address}`);
  console.log('\n• Balance Changes:');
  tx.effects?.balanceChanges?.nodes?.forEach(bc => {
    const isGain = !bc.amount.startsWith('-');
    const amountSui = (Math.abs(Number(bc.amount)) / 1e9).toFixed(4);
    console.log(`  ${isGain ? '🟢 +' : '🔴 -'}${amountSui} SUI (${bc.owner?.address})`);
  });
  console.log('====================================================\n');
}

check().catch(console.error);
