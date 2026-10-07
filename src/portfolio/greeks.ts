import { getOptionMark } from '../data/market.js';
import { logger } from '../logging.js';
import type { OptionsGreeks } from '../types.js';
import { getPortfolioState, updatePositionGreeks, updatePositionPrice } from './tracker.js';

/**
 * Tracks the Greeks and IV rank of open option positions: what they were at entry (so the evaluator
 * and dashboard can see whether entries were cheap) and what they are now.
 */

export interface GreeksRecord {
  optionSymbol: string;
  underlying: string;
  ivRankAtEntry: number;
  deltaAtEntry: number;
  thetaAtEntry: number;
  dteAtEntry: number;
  enteredAt: string;
  latest: OptionsGreeks;
  updatedAt: string;
}

const book = new Map<string, GreeksRecord>();

export function recordEntryGreeks(optionSymbol: string, underlying: string, greeks: OptionsGreeks): void {
  const now = new Date().toISOString();
  book.set(optionSymbol, {
    optionSymbol,
    underlying,
    ivRankAtEntry: greeks.ivRank,
    deltaAtEntry: greeks.delta,
    thetaAtEntry: greeks.theta,
    dteAtEntry: greeks.dte,
    enteredAt: now,
    latest: greeks,
    updatedAt: now,
  });
}

export function clearGreeks(optionSymbol: string): void {
  book.delete(optionSymbol);
}

export function getGreeksBook(): GreeksRecord[] {
  return [...book.values()];
}

/** Re-marks every open option position (price = mid) and refreshes its Greeks. Failures are per position. */
export async function refreshOptionGreeks(): Promise<void> {
  const options = getPortfolioState().openPositions.filter((p) => p.assetClass === 'option');
  await Promise.all(options.map(async (p) => {
    try {
      const mark = await getOptionMark(p.symbol, p.underlying ?? p.symbol);
      if (mark.mid > 0) updatePositionPrice(p.symbol, mark.mid);
      updatePositionGreeks(p.symbol, mark.greeks);
      const rec = book.get(p.symbol);
      if (rec) {
        rec.latest = mark.greeks;
        rec.updatedAt = new Date().toISOString();
      }
    } catch (err) {
      logger.warn(`${p.symbol}: could not refresh option greeks (${(err as Error).message})`);
    }
  }));
}

/** Share-equivalent delta and per-day theta in dollars across all open option positions. */
export function getNetExposure(): { netDelta: number; dailyTheta: number } {
  let netDelta = 0;
  let dailyTheta = 0;
  for (const p of getPortfolioState().openPositions) {
    if (p.assetClass !== 'option' || !p.greeks) continue;
    const sign = p.side === 'long' ? 1 : -1;
    netDelta += sign * p.greeks.delta * p.quantity * 100;
    dailyTheta += sign * p.greeks.theta * p.quantity * 100;
  }
  return { netDelta, dailyTheta };
}
