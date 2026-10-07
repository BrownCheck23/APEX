/**
 * Daily equity cycle. Runs once per day at 4:30pm ET (30 minutes after market close).
 *
 * Entry logic is deterministic — three conditions must all be true:
 *   1. 12-month return > 0 (momentum factor)
 *   2. Price > 200-day SMA (trend filter)
 *   3. RSI-14 between rsiLowerBound and rsiUpperBound (not extended)
 *
 * Jev is called ONCE per cycle (not per symbol) to classify the overall market regime.
 * It can only veto entries. It cannot initiate them.
 *
 * Exit logic:
 *   - 5% trailing stop from the highest price seen
 *   - Price breaks below the 200-day SMA
 *   - Jev flags regime as volatile or deteriorating (trending_bearish)
 *
 * Universe: SPY and QQQ only. Position cap: 40% per symbol, 80% total.
 */

import { config } from '../config/index.js';
import { getHistoricals } from '../data/robinhood.js';
import { isRecord, parseJson, toNum } from '../data/parse.js';
import { compute12MonthReturn, compute200DaySMA, computeRSI14, isEntrySignal } from '../data/signals.js';
import { getExecutionEngine } from '../execution/engine.js';
import { OrderSkipped } from '../execution/live.js';
import { classifyRegime } from '../jev/client.js';
import { buildRegimeQuestions } from '../jev/questions.js';
import { logger } from '../logging.js';
import {
  getPortfolioState, getPosition, updatePositionPrice,
} from '../portfolio/tracker.js';
import { canTrade } from '../risk/killswitch.js';
import type { DailySignal, JevFilter, PortfolioState, StrategyConfig } from '../types.js';
import { closeTrackedPosition, logDecision, logExecution, openTrackedPosition, positionQuantity } from './common.js';

const UNIVERSE = ['SPY', 'QQQ'];
const MAX_PER_SYMBOL_PCT = 0.40;
const MAX_TOTAL_DEPLOYED_PCT = 0.80;
const TRAILING_STOP_PCT = 0.05;

// Per-symbol high-water marks for the trailing stop (reset when position is closed)
const highWaterMarks = new Map<string, number>();

function deployedPct(portfolio: PortfolioState): number {
  const invested = portfolio.openPositions
    .filter((p) => UNIVERSE.includes(p.symbol) && p.assetClass === 'equity')
    .reduce((a, p) => a + p.currentPrice * p.quantity, 0);
  return portfolio.totalValue > 0 ? invested / portfolio.totalValue : 0;
}

async function fetchCloses(symbol: string): Promise<number[]> {
  const raw = parseJson<unknown>(await getHistoricals(symbol, { interval: 'day', span: 'year' }));
  if (!isRecord(raw) || !Array.isArray(raw.bars)) return [];
  return (raw.bars as unknown[])
    .filter(isRecord)
    .map((b) => toNum(b.close))
    .filter((c) => c > 0);
}

async function buildSignal(symbol: string, cfg: StrategyConfig): Promise<DailySignal | null> {
  let closes: number[];
  try {
    closes = await fetchCloses(symbol);
  } catch (err) {
    logger.warn(`${symbol}: failed to fetch historicals — ${(err as Error).message}`);
    return null;
  }

  if (closes.length < 200) {
    logger.warn(`${symbol}: only ${closes.length} daily bars — need 200 for SMA, skipping`);
    return null;
  }

  const price = closes[closes.length - 1];
  const momentum12m = compute12MonthReturn(closes);
  const sma200 = compute200DaySMA(closes);
  const rsi14 = computeRSI14(closes);
  const entry = isEntrySignal(closes, cfg.rsiLowerBound, cfg.rsiUpperBound);

  return {
    symbol,
    momentum12m,
    price,
    sma200,
    rsi14,
    entryAllowed: entry.all,
    regime: '',       // filled in after the Jev call
    isCoherent: false,
  };
}

function shouldExit(symbol: string, price: number, sma200: number, filter: JevFilter): string | null {
  const highWater = highWaterMarks.get(symbol) ?? price;
  if (price > highWater) highWaterMarks.set(symbol, price);
  const effective = highWaterMarks.get(symbol) ?? price;

  if (price <= effective * (1 - TRAILING_STOP_PCT)) {
    return `trailing stop: price ${price.toFixed(2)} <= high-water ${effective.toFixed(2)} - ${TRAILING_STOP_PCT * 100}%`;
  }
  if (sma200 > 0 && price < sma200) {
    return `price ${price.toFixed(2)} < 200-day SMA ${sma200.toFixed(2)}`;
  }
  if (filter.regime === 'volatile' || filter.regime === 'trending_bearish') {
    return `regime deteriorated: ${filter.regime}`;
  }
  return null;
}

export async function runEquityCycle(
  _symbols: string[],
  strategyConfig: StrategyConfig,
  _portfolioState: PortfolioState,
): Promise<void> {
  if (!canTrade()) {
    logger.warn('Kill switch active — equity cycle stopped');
    return;
  }

  // 1. Fetch daily bars for all universe symbols in parallel (no API cost).
  const signalResults = await Promise.all(UNIVERSE.map((sym) => buildSignal(sym, strategyConfig)));
  const signals = new Map<string, DailySignal>(
    UNIVERSE.flatMap((sym, i) => {
      const sig = signalResults[i];
      return sig ? [[sym, sig]] : [];
    }),
  );

  if (signals.size === 0) {
    logger.warn('No valid daily bar data — skipping equity cycle');
    return;
  }

  // 2. Jev regime call: ONE call for the whole cycle with the market state.
  const marketState = {
    symbols: UNIVERSE.join(','),
    momentum12m_SPY: signals.get('SPY')?.momentum12m ?? 0,
    momentum12m_QQQ: signals.get('QQQ')?.momentum12m ?? 0,
    price_SPY: signals.get('SPY')?.price ?? 0,
    sma200_SPY: signals.get('SPY')?.sma200 ?? 0,
    rsi14_SPY: signals.get('SPY')?.rsi14 ?? 50,
    price_QQQ: signals.get('QQQ')?.price ?? 0,
    sma200_QQQ: signals.get('QQQ')?.sma200 ?? 0,
    rsi14_QQQ: signals.get('QQQ')?.rsi14 ?? 50,
  };

  let filter: JevFilter;
  try {
    filter = await classifyRegime(marketState, buildRegimeQuestions());
    logger.info(`Jev regime: ${filter.regime} (confidence ${filter.confidence.toFixed(2)}, coherent: ${filter.isCoherent})`);
  } catch (err) {
    logger.warn(`Jev unavailable: ${(err as Error).message} — skipping equity cycle`);
    return;
  }

  // Stamp regime on signals now that we have it.
  for (const sig of signals.values()) {
    sig.regime = filter.regime;
    sig.isCoherent = filter.isCoherent;
  }

  // 3. Per-symbol decisions.
  for (const symbol of UNIVERSE) {
    const sig = signals.get(symbol);
    if (!sig) continue;

    updatePositionPrice(symbol, sig.price);
    const portfolio = getPortfolioState();
    const pos = getPosition(symbol);
    const base = {
      symbol,
      assetClass: 'equity' as const,
      regime: filter.regime,
      price: sig.price,
      state: sig,
      filter: { confidence: filter.confidence, isCoherent: filter.isCoherent, regime: filter.regime },
    };

    if (pos) {
      // Check exits first.
      const exitReason = shouldExit(symbol, sig.price, sig.sma200, filter);
      if (exitReason) {
        try {
          const engine = getExecutionEngine();
          const quote = { price: sig.price, bidPrice: sig.price * 0.9995, askPrice: sig.price * 1.0005 };
          const fill = await engine.placeEquityOrder({ symbol, side: 'sell', quantity: pos.quantity, type: 'market', quote });
          const pnl = closeTrackedPosition({ ...base, fillPrice: fill.filledPrice, orderId: fill.orderId, reason: exitReason });
          highWaterMarks.delete(symbol);
          logger.info(`${symbol}: exited — ${exitReason} — realised P&L ${pnl.toFixed(2)}`);
        } catch (err) {
          if (err instanceof OrderSkipped) {
            logDecision({ ...base, action: 'hold', reason: `exit blocked by order review: ${err.message}` });
          } else {
            logDecision({ ...base, action: 'hold', reason: `exit failed: ${(err as Error).message}` });
            logger.error(`${symbol}: exit failed — ${(err as Error).message}`);
          }
        }
      } else {
        logDecision({ ...base, action: 'hold', reason: `holding — no exit trigger` });
      }
      continue;
    }

    // No position — evaluate entry.
    if (!sig.entryAllowed) {
      const detail = [
        !sig.momentum12m ? `momentum negative (${(sig.momentum12m * 100).toFixed(1)}%)` : null,
        sig.price <= sig.sma200 ? `price ${sig.price.toFixed(2)} <= 200-SMA ${sig.sma200.toFixed(2)}` : null,
        sig.rsi14 < strategyConfig.rsiLowerBound || sig.rsi14 > strategyConfig.rsiUpperBound
          ? `RSI ${sig.rsi14.toFixed(1)} outside [${strategyConfig.rsiLowerBound}, ${strategyConfig.rsiUpperBound}]` : null,
      ].filter(Boolean).join('; ');
      logDecision({ ...base, action: 'hold', reason: `entry conditions not met: ${detail}` });
      continue;
    }

    if (filter.confidence < strategyConfig.confidenceThreshold) {
      logDecision({ ...base, action: 'hold', reason: `Jev confidence ${filter.confidence.toFixed(3)} < threshold ${strategyConfig.confidenceThreshold}` });
      continue;
    }
    if (!filter.isCoherent) {
      logDecision({ ...base, action: 'hold', reason: 'Jev flagged conditions as incoherent' });
      continue;
    }
    if (filter.regime === 'volatile' || filter.regime === 'trending_bearish') {
      logDecision({ ...base, action: 'hold', reason: `entry vetoed: Jev regime is ${filter.regime}` });
      continue;
    }

    // Check position sizing caps.
    if (deployedPct(portfolio) >= MAX_TOTAL_DEPLOYED_PCT) {
      logDecision({ ...base, action: 'hold', reason: `total deployment ${(deployedPct(portfolio) * 100).toFixed(0)}% >= 80% cap` });
      continue;
    }

    const quantity = positionQuantity(sig.price, portfolio, strategyConfig, { maxPct: MAX_PER_SYMBOL_PCT });
    if (quantity < 1) {
      logDecision({ ...base, action: 'hold', reason: `position size rounds to 0 (price ${sig.price}, cash ${portfolio.cash.toFixed(2)})` });
      continue;
    }

    try {
      const quote = { price: sig.price, bidPrice: sig.price * 0.9995, askPrice: sig.price * 1.0005 };
      const engine = getExecutionEngine();
      const fill = await engine.placeEquityOrder({ symbol, side: 'buy', quantity, type: 'market', quote });
      const entry = {
        ...base,
        action: 'buy' as const,
        quantity,
        fillPrice: fill.filledPrice,
        orderId: fill.orderId,
        reason: `entry: momentum ${(sig.momentum12m * 100).toFixed(1)}%, price ${sig.price.toFixed(2)} > SMA200 ${sig.sma200.toFixed(2)}, RSI ${sig.rsi14.toFixed(1)}, regime ${filter.regime}`,
      };
      const id = logExecution(entry);
      openTrackedPosition(entry, id);
      highWaterMarks.set(symbol, fill.filledPrice);
    } catch (err) {
      if (err instanceof OrderSkipped) {
        logDecision({ ...base, action: 'buy', reason: `skipped by order review: ${err.message}` });
      } else {
        logDecision({ ...base, action: 'buy', reason: `execution failed: ${(err as Error).message}` });
        logger.error(`${symbol}: execution failed — ${(err as Error).message}`);
      }
    }
  }
}
