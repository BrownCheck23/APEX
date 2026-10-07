import express from 'express';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { getStrategyConfig } from '../config/strategy.js';
import { getDb, getRecentTrades, initializeDatabase } from '../learning/logger.js';
import { logger } from '../logging.js';
import { getGreeksBook, getNetExposure } from '../portfolio/greeks.js';
import { getPortfolioState } from '../portfolio/tracker.js';
import { killSwitch } from '../risk/killswitch.js';
import type { PortfolioState, TradeRecord } from '../types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** In-process the live portfolio is available; run standalone, fall back to the last logged snapshot. */
function portfolioForDashboard(): PortfolioState | { unavailable: true; lastSnapshot: unknown } {
  try {
    return getPortfolioState();
  } catch {
    const snap = getDb().prepare(`SELECT * FROM portfolio_snapshots ORDER BY id DESC LIMIT 1`).get();
    return { unavailable: true, lastSnapshot: snap ?? null };
  }
}

function reasonOf(t: TradeRecord): string {
  try {
    const r = (JSON.parse(t.stateSnapshot) as { reason?: unknown }).reason;
    return typeof r === 'string' ? r : '';
  } catch {
    return '';
  }
}

export function createDashboardApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/status', (_req, res) => {
    const strategy = getStrategyConfig();
    const decisions = getRecentTrades(10).reverse().map((t) => ({
      id: t.id, timestamp: t.timestamp, symbol: t.symbol, assetClass: t.assetClass, regime: t.regime,
      action: t.action, quantity: t.quantity, price: t.price, confidence: t.confidence,
      pnl: t.pnl, pnlPct: t.pnlPct, reason: reasonOf(t),
    }));
    // No config object, env value or key is ever serialised here (rule 5).
    res.json({
      mode: config.paperMode ? 'paper' : 'live',
      portfolio: portfolioForDashboard(),
      killSwitch: killSwitch.getState(),
      strategy: {
        version: strategy.version,
        updatedAt: strategy.updatedAt,
        confidenceThreshold: strategy.confidenceThreshold,
        positionSizingFactor: strategy.positionSizingFactor,
      },
      options: { exposure: getNetExposure(), greeks: getGreeksBook() },
      decisions,
    });
  });

  app.get('/trades', (_req, res) => {
    res.json(getRecentTrades(50).reverse());
  });

  app.get('/', (_req, res) => {
    res.sendFile(path.join(here, 'public', 'index.html'));
  });

  return app;
}

export function startDashboard(): Server {
  initializeDatabase();
  // Localhost only: the dashboard has no authentication.
  const server = createDashboardApp().listen(config.dashboardPort, '127.0.0.1');
  server.on('error', (err) => logger.error(`Dashboard failed to start: ${(err as Error).message}`));
  return server;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  startDashboard();
  logger.info(`Dashboard (standalone, database view only) at http://localhost:${config.dashboardPort}`);
}
