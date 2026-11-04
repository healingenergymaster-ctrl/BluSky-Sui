// src/server.mjs
// BluSky-Sui Web Dashboard Server & REST API

// Catch any unhandled promise rejections or background RPC socket drops
process.on('unhandledRejection', () => {});
process.on('uncaughtException', (err) => {
  if (err.message?.includes('fetch failed') || err.message?.includes('INVALID_ARGUMENT')) return;
  console.warn('[Server Warning]', err.message);
});

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SUI_CONFIG } from './config.mjs';
import { VaultApiService } from './dashboard/vaultApi.mjs';
import { TurbosService, fetchLiveSuiPrice } from './services/turbos.mjs';
import { HedgingEngine } from './hedging/hedgingEngine.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PORT = process.env.PORT || 3000;

// State management for interactive demo
let currentScenario = 'normal'; // 'normal', 'drift', 'hedge'

const vaultApi = new VaultApiService();
const turbosService = new TurbosService();
const hedgingEngine = new HedgingEngine({ turbosService });

async function getLiveState(userAddress = null) {
  const livePrice = await fetchLiveSuiPrice();
  let simPrice = livePrice;
  if (currentScenario === 'drift') {
    simPrice = 0.78; // Below $0.8026 lower bound!
  } else if (currentScenario === 'hedge') {
    simPrice = 0.83; // Noticeable drop from ~$0.895
  } else {
    simPrice = livePrice;
  }

  // 1. Analyze Position
  const clmmAnalysis = await turbosService.analyzePosition(
    SUI_CONFIG.pools.turbos_sui_usdc,
    SUI_CONFIG.targetPositionNft
  );
  clmmAnalysis.pool.currentPrice = simPrice;

  // 2. Hedging Evaluation
  const hedgeReport = await hedgingEngine.evaluateAndHedge(clmmAnalysis, simPrice);

  // 3. Vault Summary
  const vaultSummary = await vaultApi.getPublicVaultSummary(simPrice);

  const targetLower = Math.round(simPrice * 0.90 * 1000) / 1000;
  const targetUpper = Math.round(simPrice * 1.10 * 1000) / 1000;

  let userPosition = null;
  if (userAddress) {
    userPosition = await vaultApi.getUserPosition(userAddress, simPrice);
  }

  return {
    scenario: currentScenario,
    currentPrice: simPrice,
    clmm: {
      poolId: clmmAnalysis.pool.objectId,
      price: simPrice,
      lowerPrice: clmmAnalysis.rangeMetrics.priceLower,
      upperPrice: clmmAnalysis.rangeMetrics.priceUpper,
      progressPct: clmmAnalysis.rangeMetrics.progressPct,
      nearestBoundaryPct: clmmAnalysis.rangeMetrics.nearestBoundaryDistancePct,
      inRange: clmmAnalysis.rangeMetrics.inRange,
      isDriftTriggered: clmmAnalysis.rangeMetrics.isDriftTriggered,
      accruedFeesUsd: clmmAnalysis.accruedFees.totalFeesUsd,
      accruedFeesSui: clmmAnalysis.accruedFees.feeA_Sui,
      accruedFeesUsdc: clmmAnalysis.accruedFees.feeB_Usdc,
      shouldRebalance: clmmAnalysis.shouldRebalance,
      rebalanceAction: clmmAnalysis.shouldRebalance ? 'REBALANCED_SIMULATED' : 'HOLDING',
      targetNewBand: clmmAnalysis.shouldRebalance ? { lower: targetLower, upper: targetUpper } : null,
      volume24hUsd: vaultSummary.apy.volume24hUsd,
      poolLiquidityUsd: vaultSummary.apy.poolLiquidityUsd,
      concentrationMultiplier: vaultSummary.apy.concentrationMultiplier
    },
    hedging: {
      market: hedgeReport.perpStatus.market,
      spotDeltaSui: hedgeReport.spotMetrics.spotDeltaSui,
      spotDeltaUsd: hedgeReport.spotMetrics.spotDeltaUsd,
      perpShortSizeSui: hedgeReport.perpStatus.shortSizeSui,
      perpShortNotionalUsd: hedgeReport.perpStatus.notionalUsd,
      netDeltaSui: hedgeReport.deltaStatus.netDeltaSui,
      netDeltaUsd: hedgeReport.deltaStatus.netDeltaUsd,
      deltaDriftPct: hedgeReport.deltaStatus.deltaDriftPct,
      requiresRehedge: hedgeReport.deltaStatus.requiresRehedge,
      adjustmentAction: hedgeReport.deltaStatus.adjustmentAction,
      adjustmentResult: hedgeReport.adjustmentResult,
      fundingRate8hPct: hedgeReport.fundingInfo.rate8hPct,
      annualizedFundingApr: hedgeReport.fundingInfo.annualizedApr,
      liquidationPrice: hedgeReport.perpStatus.marginHealth?.liquidationPrice || 5.02,
      liquidationBufferPct: hedgeReport.perpStatus.marginHealth?.safetyMarginToLiqPct || 145.0,
      netApy: hedgeReport.apyBreakdown.netMarketNeutralApy
    },
    vault: vaultSummary,
    userPosition,
    timestamp: new Date().toISOString()
  };
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = reqUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API Endpoints ---

  if (pathname === '/api/status' && req.method === 'GET') {
    const address = reqUrl.searchParams.get('address');
    const data = await getLiveState(address);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  if (pathname === '/api/user/position' && req.method === 'GET') {
    const address = reqUrl.searchParams.get('address');
    const simPrice = (currentScenario === 'drift') ? 0.78 : ((currentScenario === 'hedge') ? 0.83 : await fetchLiveSuiPrice());
    const position = await vaultApi.getUserPosition(address, simPrice);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, position }));
    return;
  }

  if (pathname === '/api/vault/deposit' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const userAddress = payload.userAddress || payload.address;
        const amountUsdc = parseFloat(payload.amountUsdc || payload.amount || 0);
        const simPrice = (currentScenario === 'drift') ? 0.78 : ((currentScenario === 'hedge') ? 0.83 : await fetchLiveSuiPrice());
        const result = await vaultApi.executeDeposit(userAddress, amountUsdc, simPrice);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, result }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  if (pathname === '/api/vault/withdraw' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const userAddress = payload.userAddress || payload.address;
        const shares = parseFloat(payload.shares || payload.sharesToBurn || 0);
        const simPrice = (currentScenario === 'drift') ? 0.78 : ((currentScenario === 'hedge') ? 0.83 : await fetchLiveSuiPrice());
        const result = await vaultApi.executeWithdraw(userAddress, shares, simPrice);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, result }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  if (pathname === '/api/simulate' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        if (payload.scenario) {
          currentScenario = payload.scenario;
        }
        const address = payload.address || null;
        const data = await getLiveState(address);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, scenario: currentScenario, state: data }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (pathname === '/api/deposit' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const amountUsdc = parseFloat(payload.amountUsdc || 1000);
        const livePrice = await fetchLiveSuiPrice();
        const sim = await vaultApi.simulateDeposit(amountUsdc, livePrice);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, simulation: sim }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // --- Static File Serving ---

  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
  };

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // Fallback to index.html for SPA
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, content2) => {
          if (err2) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content2);
          }
        });
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`🌊 BluSky-Sui Web Dashboard live at: http://localhost:${PORT}`);
});

