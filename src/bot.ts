import cron from 'node-cron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config/index.js';
import { getStrategyConfig } from './config/strategy.js';
import { startDashboard } from './dashboard/server.js';
import { closeDatabase, getRecentTrades, initializeDatabase, logPortfolioSnapshot } from './learning/logger.js';
import { runEvaluationIfNeeded } from './learning/evaluator.js';
import { logger } from './logging.js';
import { closeRobinhood, describeCapabilities, NOT_WIRED } from './data/robinhood.js';
import { getPortfolioState, initializePaperPortfolio, refreshLivePortfolio } from './portfolio/tracker.js';
import { killSwitch } from './risk/killswitch.js';
import { runEquityCycle } from './strategy/equity.js';

let queue: Promise<void> = Promise.resolve();
const pending = new Set<string>();

function enqueue(name: string, job: () => Promise<void>): void {
  if (pending.has(name)) {
    logger.warn(`${name}: previous cycle still queued or running — skipping this tick`);
    return;
  }
  pending.add(name);
  queue = queue.then(async () => {
    try {
      await job();
    } catch (err) {
      logger.error(`${name} cycle failed: ${(err as Error).message}`);
    } finally {
      pending.delete(name);
    }
  });
}

export function isMarketOpen(now: Date = new Date()): boolean {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hours = et.getHours();
  const minutes = et.getMinutes();
  const day = et.getDay();

  if (day === 0 || day === 6) return false;
  const timeInMinutes = hours * 60 + minutes;
  return timeInMinutes >= 570 && timeInMinutes < 960; // 9:30 to 16:00
}

const bypassMarketHours = () => config.offlineSim && process.env.APEX_FORCE_MARKET_OPEN === 'true';

export async function equityCycle(): Promise<void> {
  await refreshLivePortfolio();
  const strategyConfig = getStrategyConfig();

  killSwitch.check(getPortfolioState(), getRecentTrades(50));
  if (killSwitch.isActive()) {
    logPortfolioSnapshot(getPortfolioState());
    return;
  }

  const portfolio = getPortfolioState();
  try {
    await runEquityCycle([], strategyConfig, portfolio);
  } catch (err) {
    logger.error(`equity track failed: ${(err as Error).message}`);
  }

  await runEvaluationIfNeeded();
  logPortfolioSnapshot(getPortfolioState());
}

async function reportRobinhoodCapabilities(): Promise<void> {
  try {
    const { tools, candidates } = await describeCapabilities();
    logger.info(`Robinhood MCP connected. Tools: ${tools.join(', ')}`);
    logger.info(`Not wired: ${NOT_WIRED.join('; ')}`);
    if (candidates.length) logger.warn(`Unexpected tools: ${candidates.join(', ')}. Run "npm run robinhood:tools" to inspect.`);
  } catch (err) {
    logger.error(`Could not connect to the Robinhood MCP server: ${(err as Error).message}`);
    throw err;
  }
}

export async function startBot(opts: { once?: boolean } = {}): Promise<void> {
  logger.info(`APEX starting in ${config.paperMode ? 'PAPER' : '⚠️  LIVE'} mode${config.offlineSim ? ' (offline simulation: no external API calls)' : ''}`);
  logger.info('Strategy: daily deterministic (momentum + 200-day SMA + RSI-14), Jev as regime classifier only. Universe: SPY, QQQ.');

  initializeDatabase();
  if (!config.offlineSim) await reportRobinhoodCapabilities();
  if (config.paperMode) initializePaperPortfolio(config.paperStartingCash);
  else await refreshLivePortfolio();

  if (opts.once) {
    if (!isMarketOpen() && !bypassMarketHours()) {
      logger.info('Market closed — running cycle anyway for --once mode');
    }
    await equityCycle();
    const p = getPortfolioState();
    await closeRobinhood();
    logger.info(`Single cycle complete: value $${p.totalValue.toFixed(2)}, P&L ${p.totalPnl.toFixed(2)}, open positions ${p.openPositions.length}`);
    return;
  }

  // 4:30pm ET, Mon-Fri — 30 minutes after market close
  const equityTask = cron.schedule(
    '30 16 * * 1-5',
    () => enqueue('equity', equityCycle),
    { timezone: 'America/New_York' },
  );

  startDashboard();
  logger.info('Bot running. Dashboard at http://localhost:' + config.dashboardPort);
  logger.info('Next equity cycle: 4:30pm ET weekdays');

  const shutdown = (signal: string) => {
    logger.info(`${signal} received — stopping`);
    equityTask.stop();
    queue.finally(async () => {
      await closeRobinhood();
      closeDatabase();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  startBot({ once: process.argv.includes('--once') }).catch((err) => {
    logger.error('Fatal startup error:', err);
    process.exit(1);
  });
}
