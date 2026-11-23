// src/compat/suiClientHook.mjs
// Compatibility hook for Node ESM/require(ESM) so legacy SDKs (e.g. @cetusprotocol/cetus-sui-clmm-sdk)
// importing removed @mysten v1 exports work cleanly against @mysten/sui v2 and @mysten/bcs v2.
import { registerHooks } from 'node:module';

const SUI_CLIENT_SUFFIX = '/@mysten/sui/dist/client/index.mjs';
const BCS_INDEX_SUFFIX = '/@mysten/bcs/dist/index.mjs';

function toSourceText(source) {
  return typeof source === 'string' ? source : Buffer.from(source).toString('utf8');
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (result.source == null) return result;
    const normalizedUrl = url.replace(/\\/g, '/');

    if (normalizedUrl.endsWith(SUI_CLIENT_SUFFIX)) {
      const src = toSourceText(result.source);
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

    if (normalizedUrl.endsWith(BCS_INDEX_SUFFIX)) {
      const src = toSourceText(result.source);
      const bcsAliases = [];
      if (!/\bfromB64\b/.test(src)) bcsAliases.push('fromBase64 as fromB64');
      if (!/\bfromHEX\b/.test(src)) bcsAliases.push('fromHex as fromHEX');
      if (!/\btoB64\b/.test(src)) bcsAliases.push('toBase64 as toB64');
      if (!/\btoHEX\b/.test(src)) bcsAliases.push('toHex as toHEX');
      if (bcsAliases.length > 0) {
        return {
          ...result,
          shortCircuit: true,
          source: `${src}\nexport { ${bcsAliases.join(', ')} } from '@mysten/utils';\n`
        };
      }
    }

    return result;
  }
});

