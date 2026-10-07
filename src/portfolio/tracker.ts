import { config } from '../config/index.js';
import { getPortfolio, getPositions } from '../data/robinhood.js';
import { isRecord, parseJson, toNum, toNumOrNull } from '../data/parse.js';
import { getKv, setKv, updateTradePnl } from '../learning/logger.js';
import { logger } from '../logging.js';
import type { AssetClass, OptionsGreeks, PortfolioState, Position, TradeRecord } from '../types.js';

/**
 * Portfolio state.
 *  - Paper mode: everything is local. Opening a position moves its notional out of cash (or, for a
 *    short, proceeds in); closing reverses it and realises P&L.
 *  - Live mode: refreshLivePortfolio() pulls state from Robinhood (through the Claude MCP wrapper)
 *    into the same cache, and getPortfolioState() stays synchronous as the spec requires.
 */

const OPTION_MULTIPLIER = 100;
const mult = (c: AssetClass) => (c === 'option' ? OPTION_MULTIPLIER : 1);

interface RealizedEntry { symbol: string; pnl: number; day: string }

let cash = 0;
let startingValue = 0;
let dayStartValue = 0;
let dayKey = '';
let tradeCount = 0;
let winCount = 0;
const positions = new Map<string, Position>();
let realized: RealizedEntry[] = [];
let initialized = false;

const today = () => new Date().toISOString().slice(0, 10);

/** Signed market value: shorts are a liability. */
function marketValue(p: Position): number {
  const v = p.currentPrice * p.quantity * mult(p.assetClass);
  return p.side === 'long' ? v : -v;
}

function unrealized(p: Position): { pnl: number; pct: number } {
  const dir = p.side === 'long' ? 1 : -1;
  const pnl = (p.currentPrice - p.entryPrice) * p.quantity * mult(p.assetClass) * dir;
  const basis = p.entryPrice * p.quantity * mult(p.assetClass);
  return { pnl, pct: basis > 0 ? (pnl / basis) * 100 : 0 };
}

function rollDay(): void {
  const k = today();
  if (k !== dayKey) {
    dayKey = k;
    dayStartValue = totalValueNow();
    realized = realized.filter((r) => r.day === k);
  }
}

function totalValueNow(): number {
  let v = cash;
  for (const p of positions.values()) v += marketValue(p);
  return v;
}

export function initializePaperPortfolio(startingCash: number): void {
  cash = startingCash;
  startingValue = startingCash;
  dayStartValue = startingCash;
  dayKey = today();
  tradeCount = 0;
  winCount = 0;
  realized = [];
  positions.clear();
  initialized = true;
}

export function getPortfolioState(): PortfolioState {
  if (!initialized) throw new Error('Portfolio not initialised — call initializePaperPortfolio() or refreshLivePortfolio() first');
  rollDay();

  const openPositions: Position[] = [];
  for (const p of positions.values()) {
    const u = unrealized(p);
    openPositions.push({ ...p, unrealizedPnl: u.pnl, unrealizedPnlPct: u.pct });
  }
  const totalValue = totalValueNow();
  const totalPnl = totalValue - startingValue;
  return {
    totalValue,
    startingValue,
    totalPnl,
    totalPnlPct: startingValue > 0 ? totalPnl / startingValue : 0,
    todayPnl: totalValue - dayStartValue,
    openPositions,
    cash,
    tradeCount,
    winCount,
    winRate: tradeCount > 0 ? winCount / tradeCount : 0,
  };
}

export interface OpenExtras {
  greeks?: OptionsGreeks;
  earningsDate?: string;
  underlying?: string;
}

/** Opens (or averages into) a position from an executed trade. `trade.id` should be its logged row id. */
export function openPosition(trade: TradeRecord, extras: OpenExtras = {}): void {
  if (trade.quantity <= 0) throw new Error('openPosition requires a positive quantity');
  if (trade.action !== 'buy' && trade.action !== 'sell') throw new Error(`openPosition cannot open on action "${trade.action}"`);
  const side: Position['side'] = trade.action === 'buy' ? 'long' : 'short';
  const existing = positions.get(trade.symbol);

  if (existing) {
    if (existing.side !== side) throw new Error(`${trade.symbol}: opposite-side open — close the existing position first`);
    const q = existing.quantity + trade.quantity;
    existing.entryPrice = (existing.entryPrice * existing.quantity + trade.price * trade.quantity) / q;
    existing.quantity = q;
    existing.currentPrice = trade.price;
  } else {
    positions.set(trade.symbol, {
      symbol: trade.symbol,
      assetClass: trade.assetClass,
      side,
      quantity: trade.quantity,
      entryPrice: trade.price,
      entryTimestamp: trade.timestamp,
      currentPrice: trade.price,
      unrealizedPnl: 0,
      unrealizedPnlPct: 0,
      tradeId: trade.id,
      ...extras,
    });
  }

  const notional = trade.price * trade.quantity * mult(trade.assetClass);
  cash += side === 'long' ? -notional : notional;
}

/** Closes the position in full at `currentPrice`; returns realised P&L (also written to the entry trade row). */
export function closePosition(symbol: string, currentPrice: number): number {
  const p = positions.get(symbol);
  if (!p) throw new Error(`No open position in ${symbol}`);
  rollDay();

  p.currentPrice = currentPrice;
  const { pnl, pct } = unrealized(p);
  const notional = currentPrice * p.quantity * mult(p.assetClass);
  cash += p.side === 'long' ? notional : -notional;

  positions.delete(symbol);
  tradeCount += 1;
  if (pnl > 0) winCount += 1;
  realized.push({ symbol: p.underlying ?? symbol, pnl, day: today() });

  if (p.tradeId !== undefined) updateTradePnl(p.tradeId, pnl, pct);
  return pnl;
}

export function updatePositionPrice(symbol: string, currentPrice: number): void {
  const p = positions.get(symbol);
  if (!p) return;
  p.currentPrice = currentPrice;
}

export function updatePositionGreeks(symbol: string, greeks: OptionsGreeks): void {
  const p = positions.get(symbol);
  if (p) p.greeks = greeks;
}

export function getPosition(symbol: string): Position | undefined {
  const p = positions.get(symbol);
  if (!p) return undefined;
  const u = unrealized(p);
  return { ...p, unrealizedPnl: u.pnl, unrealizedPnlPct: u.pct };
}

/** Realised + unrealised P&L today for one symbol (options count toward their underlying). */
export function getSymbolPnlToday(symbol: string): number {
  rollDay();
  let pnl = realized.filter((r) => r.symbol === symbol).reduce((a, r) => a + r.pnl, 0);
  for (const p of positions.values()) {
    if ((p.underlying ?? p.symbol) === symbol) pnl += unrealized(p).pnl;
  }
  return pnl;
}

// ─── Live mode ───────────────────────────────────────────────────────────────

/** Live mode only: pull cash, total value and positions from Robinhood into the local cache. */
export async function refreshLivePortfolio(): Promise<void> {
  if (config.paperMode) return;

  const acct = parseJson<unknown>(await getPortfolio(config.accountNumber));
  if (!isRecord(acct)) throw new Error('Unexpected portfolio payload from Robinhood');
  const totalValue = toNum(acct.totalValue);
  cash = toNum(acct.cash ?? acct.buyingPower);

  const posRaw = parseJson<unknown>(await getPositions(config.accountNumber));
  const list = isRecord(posRaw) && Array.isArray(posRaw.positions) ? posRaw.positions : Array.isArray(posRaw) ? posRaw : [];

  const previous = new Map(positions); // keep local bookkeeping (entry trade id, underlying, earnings) across the rebuild
  positions.clear();
  for (const item of list) {
    if (!isRecord(item)) continue;
    const assetClass = (['equity', 'option', 'crypto'].includes(String(item.assetClass)) ? item.assetClass : 'equity') as AssetClass;
    const qty = toNum(item.quantity, 0);
    if (qty <= 0) continue;
    const avg = toNum(item.averagePrice, 0);
    const cur = toNum(item.currentPrice, avg);
    const delta = toNumOrNull(item.delta);
    const dte = toNumOrNull(item.dte);
    const sym = String(item.symbol);
    positions.set(sym, {
      symbol: sym,
      assetClass,
      side: item.side === 'short' ? 'short' : 'long',
      quantity: qty,
      entryPrice: avg,
      entryTimestamp: String(item.openedAt ?? new Date().toISOString()),
      currentPrice: cur,
      unrealizedPnl: 0,
      unrealizedPnlPct: 0,
      earningsDate: item.earningsDate ? String(item.earningsDate) : previous.get(sym)?.earningsDate,
      underlying: previous.get(sym)?.underlying,
      tradeId: previous.get(sym)?.tradeId,
      greeks: assetClass === 'option' && delta !== null && dte !== null
        ? {
            delta, dte,
            theta: toNum(item.theta, 0), gamma: toNum(item.gamma, 0), vega: toNum(item.vega, 0),
            impliedVolatility: toNum(item.impliedVolatility, 0), ivRank: toNum(item.ivRank, 0),
          }
        : undefined,
    });
  }

  // Positions came from Robinhood, so cash + marks should equal its reported total.
  if (!initialized) {
    const envStart = process.env.LIVE_STARTING_CAPITAL ? Number(process.env.LIVE_STARTING_CAPITAL) : NaN;
    const saved = getKv('live_starting_value');
    startingValue = Number.isFinite(envStart) && envStart > 0 ? envStart : saved ? Number(saved) : totalValue;
    if (!saved) setKv('live_starting_value', String(startingValue));
    dayStartValue = totalValue;
    dayKey = today();
    initialized = true;
    logger.info(`Live portfolio initialised: starting value $${startingValue.toFixed(2)}`);
  }
  // Keep cash consistent with the reported total even if position marks differ slightly.
  const marks = [...positions.values()].reduce((a, p) => a + marketValue(p), 0);
  cash = totalValue - marks;
}
