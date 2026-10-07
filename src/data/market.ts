import { logger } from '../logging.js';
import { daysUntil, clamp } from '../util.js';
import type { L2Snapshot, OptionsGreeks, Quote, TechnicalIndicators } from '../types.js';
import {
  getCryptoQuotes, getEarnings, getL2Book, getOptionGreeks, getOptionQuote, getQuotes, getTechnicalIndicators,
} from './robinhood.js';
import { isRecord, parseJson, toNum, toNumOrNull } from './parse.js';
import { computeOFI } from './signals.js';

const INDICATORS = ['rsi14', 'macd', 'ema20', 'sma50', 'vwap', 'bollinger', 'atr14', 'volume_vs_20d_avg'];

export interface MarketSnapshot {
  quote: Quote;
  indicators: TechnicalIndicators;
  l2: L2Snapshot;
}

export interface EarningsInfo {
  earningsDate: string | null;
  earningsDaysOut: number | null;
  expectedMovePct: number | null;
  analystBuyPct: number;
}

export interface OptionData {
  greeks: OptionsGreeks;
  earningsDaysOut: number | null;
  earningsDate: string | null;
  earningsExpectedMove: number | null;
  optionSymbol: string;
  optionType: 'call' | 'put';
  strike: number;
  expiration: string;
  bid: number;
  ask: number;
}

export interface CryptoQuote extends Quote {
  change5mPct: number;
  change1hPct: number;
  rsi14: number;
  volumeVsAvg: number;
}

function list(raw: unknown, key: string): Record<string, unknown>[] {
  const arr = isRecord(raw) && Array.isArray(raw[key]) ? raw[key] : Array.isArray(raw) ? raw : [];
  return (arr as unknown[]).filter(isRecord);
}

function buildQuote(r: Record<string, unknown>, fallbackSymbol: string): Quote {
  const price = toNum(r.price ?? r.last ?? r.lastTradePrice);
  const bid = toNum(r.bid ?? r.bidPrice, price);
  const ask = toNum(r.ask ?? r.askPrice, price);
  const spread = Math.max(0, ask - bid);
  return {
    symbol: String(r.symbol ?? fallbackSymbol).toUpperCase(),
    price,
    bidPrice: bid,
    askPrice: ask,
    spread,
    spreadPct: price > 0 ? (spread / price) * 100 : 0, // percent, matching regimeThresholds.spreadVolatileMin
    volume: toNum(r.volume, 0),
    timestamp: String(r.timestamp ?? new Date().toISOString()),
  };
}

function buildIndicators(r: Record<string, unknown>, price: number): TechnicalIndicators {
  const vwap = toNum(r.vwap, price);
  const upper = toNum(r.bollingerUpper, price);
  const lower = toNum(r.bollingerLower, price);
  const band = upper - lower;
  return {
    symbol: String(r.symbol ?? ''),
    rsi14: toNum(r.rsi14, 50),
    macdLine: toNum(r.macdLine, 0),
    macdSignal: toNum(r.macdSignal, 0),
    macdHistogram: toNum(r.macdHistogram, 0),
    prevMacdHistogram: toNumOrNull(r.prevMacdHistogram) ?? undefined,
    ema20: toNum(r.ema20, price),
    sma50: toNum(r.sma50, price),
    vwap,
    vwapDeviationPct: vwap > 0 ? ((price - vwap) / vwap) * 100 : 0,
    bollingerUpper: upper,
    bollingerLower: lower,
    bollingerPosition: band > 0 ? clamp((price - lower) / band, 0, 1) : 0.5,
    atr14: toNum(r.atr14, 0),
    volumeVsAvg: toNum(r.volumeVsAvg, 1),
  };
}

function buildL2(r: Record<string, unknown>, symbol: string): L2Snapshot {
  const levels = (v: unknown) =>
    (Array.isArray(v) ? v : []).filter(isRecord).map((l) => ({ price: toNum(l.price), size: toNum(l.size, 0) }));
  const bids = levels(r.bids).sort((a, b) => b.price - a.price);
  const asks = levels(r.asks).sort((a, b) => a.price - b.price);
  const bidDepth = bids.slice(0, 5).reduce((a, l) => a + l.size, 0);
  const askDepth = asks.slice(0, 5).reduce((a, l) => a + l.size, 0);
  const snap: L2Snapshot = { symbol, bids, asks, bidDepth, askDepth, ofi: 0 };
  snap.ofi = computeOFI(snap);
  return snap;
}

/** Quotes and L2 are fetched once for the whole list; indicators are per symbol. Symbols that fail to parse are dropped. */
export async function getMarketData(symbols: string[]): Promise<Map<string, MarketSnapshot>> {
  const out = new Map<string, MarketSnapshot>();
  if (symbols.length === 0) return out;

  const [quotesRaw, l2Raw] = await Promise.all([getQuotes(symbols), getL2Book(symbols)]);
  const quotes = new Map(list(parseJson(quotesRaw), 'quotes').map((q) => {
    const quote = buildQuote(q, '');
    return [quote.symbol, quote] as const;
  }));
  const books = new Map(list(parseJson(l2Raw), 'books').map((b) => [String(b.symbol).toUpperCase(), b] as const));

  await Promise.all(symbols.map(async (sym) => {
    const key = sym.toUpperCase();
    try {
      const quote = quotes.get(key);
      const book = books.get(key);
      if (!quote || quote.price <= 0) throw new Error('no quote');
      if (!book) throw new Error('no L2 book');
      const indRaw = parseJson<unknown>(await getTechnicalIndicators(key, INDICATORS));
      if (!isRecord(indRaw)) throw new Error('bad indicator payload');
      out.set(key, {
        quote,
        indicators: { ...buildIndicators(indRaw, quote.price), symbol: key },
        l2: buildL2(book, key),
      });
    } catch (err) {
      logger.warn(`${key}: market data unavailable (${(err as Error).message})`);
    }
  }));
  return out;
}

// Earnings dates and analyst ratings change slowly; one lookup per symbol every 6 hours is plenty and
// keeps the per-cycle count of paid MCP calls down. daysOut is recomputed from the date on every read.
const EARNINGS_TTL_MS = 6 * 60 * 60 * 1000;
const earningsCache = new Map<string, { at: number; date: string | null; expectedMovePct: number | null; analystBuyPct: number }>();

export async function getEarningsInfo(symbol: string): Promise<EarningsInfo> {
  let hit = earningsCache.get(symbol);
  if (!hit || Date.now() - hit.at > EARNINGS_TTL_MS) {
    const raw = parseJson<unknown>(await getEarnings(symbol));
    const r = isRecord(raw) ? raw : {};
    hit = {
      at: Date.now(),
      date: r.earningsDate ? String(r.earningsDate).slice(0, 10) : null,
      expectedMovePct: toNumOrNull(r.expectedMovePct),
      analystBuyPct: toNum(r.analystBuyPct, 50),
    };
    earningsCache.set(symbol, hit);
  }
  return {
    earningsDate: hit.date,
    earningsDaysOut: hit.date ? daysUntil(hit.date) : null,
    expectedMovePct: hit.expectedMovePct,
    analystBuyPct: hit.analystBuyPct,
  };
}

function buildGreeks(r: Record<string, unknown>): OptionsGreeks {
  return {
    delta: toNum(r.delta),
    theta: toNum(r.theta, 0),
    gamma: toNum(r.gamma, 0),
    vega: toNum(r.vega, 0),
    impliedVolatility: toNum(r.impliedVolatility, 0),
    ivRank: toNum(r.ivRank, 100), // unknown IV rank is treated as expensive, so the IV gate blocks the trade
    dte: toNum(r.dte, 0),
  };
}

export async function getOptionData(
  symbol: string,
  sel: { targetDelta: number; minDte: number; maxDte: number; type?: 'call' | 'put' },
): Promise<OptionData> {
  const [raw, earnings] = await Promise.all([
    getOptionGreeks({ symbol, ...sel }),
    getEarningsInfo(symbol),
  ]);
  const r = parseJson<unknown>(raw);
  if (!isRecord(r) || !r.optionSymbol) throw new Error(`${symbol}: no option contract returned`);
  return {
    greeks: buildGreeks(r),
    earningsDaysOut: earnings.earningsDaysOut,
    earningsDate: earnings.earningsDate,
    earningsExpectedMove: earnings.expectedMovePct,
    optionSymbol: String(r.optionSymbol),
    optionType: r.type === 'put' ? 'put' : 'call',
    strike: toNum(r.strike, 0),
    expiration: String(r.expiration ?? ''),
    bid: toNum(r.bid, 0),
    ask: toNum(r.ask, 0),
  };
}

/** Current mark and greeks for an option contract already held. */
export async function getOptionMark(
  optionSymbol: string,
  underlying: string,
): Promise<{ mid: number; bid: number; ask: number; greeks: OptionsGreeks }> {
  const r = parseJson<unknown>(await getOptionQuote(optionSymbol, underlying));
  if (!isRecord(r)) throw new Error(`${optionSymbol}: bad option quote`);
  const bid = toNum(r.bid, 0);
  const ask = toNum(r.ask, 0);
  return { bid, ask, mid: ask > 0 ? (bid + ask) / 2 : bid, greeks: buildGreeks(r) };
}

export async function getCryptoData(symbols: string[]): Promise<Map<string, CryptoQuote>> {
  const out = new Map<string, CryptoQuote>();
  if (symbols.length === 0) return out;
  const raw = parseJson<unknown>(await getCryptoQuotes(symbols));
  for (const q of list(raw, 'quotes')) {
    try {
      const quote = buildQuote(q, '');
      out.set(quote.symbol, {
        ...quote,
        change5mPct: toNum(q.change5mPct, 0),
        change1hPct: toNum(q.change1hPct, 0),
        rsi14: toNum(q.rsi14, 50),
        volumeVsAvg: toNum(q.volumeVsAvg, 1),
      });
    } catch (err) {
      logger.warn(`crypto quote unavailable (${(err as Error).message})`);
    }
  }
  return out;
}
