// src/compat/suiClientHook.mjs
// Compatibility hook for Node ESM/require(ESM) so legacy SDKs (e.g. @cetusprotocol/cetus-sui-clmm-sdk)
// importing { SuiClient, getFullnodeUrl } from '@mysten/sui/client' work cleanly against @mysten/sui v2.
import { registerHooks } from 'node:module';

const CLIENT_SUFFIX = '/@mysten/sui/dist/client/index.mjs';

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    const normalizedUrl = url.replace(/\\/g, '/');
    if (normalizedUrl.endsWith(CLIENT_SUFFIX) && result.source != null) {
      const src = typeof result.source === 'string'
        ? result.source
        : Buffer.from(result.source).toString('utf8');
      const extras = [];
      if (!/\bSuiClient\b/.test(src)) {
        extras.push('SuiJsonRpcClient as SuiClient');
      }
      if (!/\bgetFullnodeUrl\b/.test(src)) {
        extras.push('getJsonRpcFullnodeUrl as getFullnodeUrl');
      }
      if (extras.length > 0) {
        return {
          ...result,
          shortCircuit: true,
          source: `${src}\nexport { ${extras.join(', ')} } from '../jsonRpc/index.mjs';\n`
        };
      }
    }
    return result;
  }
});
