import { config } from '../config/index.js';
import { isRecord, parseJson, toNum } from '../data/parse.js';
import { runScan } from '../data/robinhood.js';
import { logger } from '../logging.js';

const REFRESH_MS = 30 * 60 * 1000;
const MARKET_PROXIES = ['SPY', 'QQQ'];
const TICKER = /^[A-Z][A-Z.]{0,5}$/; // symbols end up inside later prompts, so only accept ticker-shaped strings

let cached: { symbols: string[]; at: number; day: string } | null = null;

export function pickWatchlist(
  results: Array<{ symbol: string; relativeVolume: number; isEtf: boolean }>,
  maxSymbols: number = config.watchlistSize,
): string[] {
  const seen = new Set<string>();
  const ranked = results
    .filter((r) => TICKER.test(r.symbol) && !seen.has(r.symbol) && (seen.add(r.symbol), true))
    .sort((a, b) => b.relativeVolume - a.relativeVolume);

  const top = ranked.slice(0, maxSymbols).map((r) => r.symbol);
  const isProxy = (s: string) => MARKET_PROXIES.includes(s);
  if (!top.some(isProxy)) {
    // Always carry a market proxy. Prefer the best-ranked one the scan returned, else SPY.
    const proxy = ranked.find((r) => isProxy(r.symbol))?.symbol ?? 'SPY';
    if (top.length >= maxSymbols) top.pop();
    top.push(proxy);
  }
  return top.slice(0, maxSymbols);
}

/** Cached for 30 minutes and re-run on the first call of each new day (market open). */
export async function getWatchlist(): Promise<string[]> {
  const day = new Date().toISOString().slice(0, 10);
  if (cached && cached.day === day && Date.now() - cached.at < REFRESH_MS) return cached.symbols;

  try {
    const raw = parseJson<unknown>(await runScan(config.scanId));
    const items = isRecord(raw) && Array.isArray(raw.results) ? raw.results : Array.isArray(raw) ? raw : [];
    const results = items.filter(isRecord).map((r) => ({
      symbol: String(r.symbol ?? '').toUpperCase(),
      relativeVolume: toNum(r.relativeVolume ?? r.relative_volume, 0),
      isEtf: Boolean(r.isEtf),
    }));
    const symbols = pickWatchlist(results);
    cached = { symbols, at: Date.now(), day };
    logger.info(`Watchlist refreshed: ${symbols.join(', ')}`);
    return symbols;
  } catch (err) {
    logger.warn(`Scanner failed (${(err as Error).message}); ${cached ? 'keeping previous watchlist' : 'falling back to SPY'}`);
    return cached?.symbols ?? ['SPY'];
  }
}
