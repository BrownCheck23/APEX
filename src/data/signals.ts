import type { L2Snapshot } from '../types.js';

/** Pure computation: no API calls, no I/O. */

// ─── Deterministic entry signals (daily bars) ──────────────────────────────

export function compute12MonthReturn(closes: number[]): number {
  if (closes.length < 253) return 0;
  const last = closes[closes.length - 1];
  const yearAgo = closes[closes.length - 253];
  if (yearAgo <= 0) return 0;
  return (last / yearAgo) - 1;
}

export function compute200DaySMA(closes: number[]): number {
  if (closes.length < 200) return 0;
  const slice = closes.slice(-200);
  return slice.reduce((a, b) => a + b, 0) / 200;
}

export function computeRSI14(closes: number[]): number {
  if (closes.length < 15) return 50;
  const changes = closes.slice(-15).map((c, i, arr) => (i === 0 ? 0 : c - arr[i - 1])).slice(1);
  let avgGain = 0;
  let avgLoss = 0;
  for (const c of changes) {
    if (c > 0) avgGain += c;
    else avgLoss += Math.abs(c);
  }
  avgGain /= 14;
  avgLoss /= 14;
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

export function isEntrySignal(
  closes: number[],
  rsiLower: number = 35,
  rsiUpper: number = 65,
): { momentum: boolean; trend: boolean; rsi: boolean; all: boolean } {
  const momentum12m = compute12MonthReturn(closes);
  const sma200 = compute200DaySMA(closes);
  const rsi14 = computeRSI14(closes);
  const price = closes.length > 0 ? closes[closes.length - 1] : 0;

  const momentum = momentum12m > 0;
  const trend = price > sma200 && sma200 > 0;
  const rsi = rsi14 >= rsiLower && rsi14 <= rsiUpper;

  return { momentum, trend, rsi, all: momentum && trend && rsi };
}

// ─── Utilities kept for the regime classifier and tests ────────────────────

export function computeOFI(l2: Pick<L2Snapshot, 'bidDepth' | 'askDepth'>): number {
  const { bidDepth, askDepth } = l2;
  const total = bidDepth + askDepth;
  if (total <= 0) return 0;
  return (bidDepth - askDepth) / total;
}

export function computeVWAPDeviation(price: number, vwap: number): number {
  if (vwap <= 0) return 0;
  return ((price - vwap) / vwap) * 100;
}
