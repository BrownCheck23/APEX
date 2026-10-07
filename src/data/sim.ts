/**
 * Offline market simulator. Active only when APEX_OFFLINE_SIM=true (paper mode only), so the whole
 * pipeline can be exercised without spending on the Anthropic / TypeSafe APIs and without touching
 * Robinhood. It returns the same JSON shapes the real MCP calls are asked to produce, so the parsers in
 * market.ts run unchanged.
 */

export type SimKind =
  | 'quotes' | 'indicators' | 'l2' | 'portfolio' | 'positions' | 'earnings'
  | 'scan' | 'optionGreeks' | 'optionQuote' | 'cryptoQuotes' | 'review' | 'historicals' | 'empty';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(Number(process.env.APEX_SIM_SEED ?? 42));
const gauss = () => {
  const u = Math.max(rand(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
};

const BASE: Record<string, number> = {
  SPY: 450, QQQ: 380, AAPL: 190, NVDA: 120, TSLA: 250, AMD: 160, MSFT: 420, META: 500,
  BTC: 65000, ETH: 3200,
};
const SCAN_POOL = ['SPY', 'NVDA', 'TSLA', 'AMD', 'AAPL', 'META', 'MSFT', 'QQQ'];
const ETFS = new Set(['SPY', 'QQQ']);

interface SymState {
  price: number;
  mom: number;      // smoothed return, drives trend signals
  hist: number;
  prevHist: number;
  vol: number;      // per-step volatility
  volumeVsAvg: number;
  spreadPct: number;
  lastStep: number;
}
const states = new Map<string, SymState>();

function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function st(symbol: string): SymState {
  let s = states.get(symbol);
  if (!s) {
    const base = BASE[symbol] ?? 40 + (hash(symbol) % 200);
    const crypto = symbol === 'BTC' || symbol === 'ETH';
    s = {
      price: base, mom: 0, hist: 0, prevHist: 0,
      vol: crypto ? 0.004 : 0.0015, volumeVsAvg: 1, spreadPct: 0.03, lastStep: 0,
    };
    states.set(symbol, s);
  }
  return s;
}

function step(symbol: string): SymState {
  const s = st(symbol);
  const ret = s.mom * 0.5 + gauss() * s.vol;
  s.price *= 1 + ret;
  s.mom = s.mom * 0.8 + ret * 0.2 + gauss() * s.vol * 0.35; // persistent trend with noise
  s.prevHist = s.hist;
  s.hist = s.mom * s.price * 8;
  const r = rand();
  s.volumeVsAvg = r < 0.07 ? 0.2 + rand() * 0.15 : Math.exp(gauss() * 0.4) * 1.2; // occasional illiquid bars
  s.spreadPct = rand() < 0.06 ? 0.35 + rand() * 0.3 : 0.01 + rand() * 0.08;        // occasional blowouts
  s.lastStep = Date.now();
  return s;
}

const round = (n: number, d = 4) => Number(n.toFixed(d));

function quoteOf(symbol: string, s: SymState) {
  const half = (s.price * s.spreadPct) / 200;
  return {
    symbol,
    price: round(s.price),
    bid: round(s.price - half),
    ask: round(s.price + half),
    volume: Math.round(s.volumeVsAvg * 1_000_000),
    timestamp: new Date().toISOString(),
  };
}

// Option contracts opened in the simulator, so premiums can move with the underlying.
const contracts = new Map<string, { underlying: string; strike: number; expiration: string; type: 'call' | 'put'; s0: number; p0: number; delta: number; theta: number; t0: number }>();

function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

export function simulate(kind: SimKind, args: Record<string, unknown> = {}): string {
  const symbols = (args.symbols as string[] | undefined) ?? [];
  const symbol = (args.symbol as string | undefined) ?? symbols[0] ?? 'SPY';

  switch (kind) {
    case 'quotes':
      return JSON.stringify({ quotes: symbols.map((sym) => quoteOf(sym, step(sym))) });

    case 'indicators': {
      const s = st(symbol);
      const sigma = s.vol * 2;
      const rsi = 50 + 42 * Math.tanh(s.mom / sigma);
      const sd = s.price * s.vol * 12;
      return JSON.stringify({
        symbol,
        rsi14: round(rsi, 2),
        macdLine: round(s.hist * 1.5), macdSignal: round(s.hist * 0.9), macdHistogram: round(s.hist),
        prevMacdHistogram: round(s.prevHist),
        ema20: round(s.price * (1 - s.mom * 2)), sma50: round(s.price * (1 - s.mom * 4)),
        vwap: round(s.price * (1 - s.mom * 3 + gauss() * 0.0008)),
        bollingerUpper: round(s.price + 2 * sd), bollingerLower: round(s.price - 2 * sd),
        atr14: round(sd),
        volumeVsAvg: round(s.volumeVsAvg, 2),
      });
    }

    case 'l2': {
      const books = symbols.map((sym) => {
        const s = st(sym);
        const target = Math.max(-0.9, Math.min(0.9, Math.tanh(s.mom / (s.vol * 1.5)) * 0.8 + gauss() * 0.1));
        const total = 5000 * (0.5 + s.volumeVsAvg);
        const bidTotal = (total * (1 + target)) / 2;
        const askTotal = (total * (1 - target)) / 2;
        const half = (s.price * s.spreadPct) / 200;
        const lvl = (tot: number, dir: 1 | -1, base: number) =>
          [0, 1, 2, 3, 4].map((i) => ({
            price: round(base + dir * i * Math.max(half, 0.01)),
            size: Math.max(1, Math.round((tot / 5) * (1 + (gauss() * 0.15)))),
          }));
        return { symbol: sym, bids: lvl(bidTotal, -1, s.price - half), asks: lvl(askTotal, 1, s.price + half) };
      });
      return JSON.stringify({ books });
    }

    case 'portfolio':
      return JSON.stringify({ totalValue: 100000, cash: 100000, buyingPower: 100000 });

    case 'positions':
      return JSON.stringify({ positions: [] });

    case 'earnings': {
      const h = hash(symbol);
      const out = ETFS.has(symbol) || symbol === 'BTC' || symbol === 'ETH' ? null : (h % 25) + 1; // 1..25 days
      return JSON.stringify({
        symbol,
        earningsDate: out === null ? null : daysFromNow(out),
        expectedMovePct: out === null ? null : round(3 + (h % 70) / 10, 1),
        analystBuyPct: 45 + (h % 45),
      });
    }

    case 'scan':
      return JSON.stringify({
        results: SCAN_POOL.map((sym) => ({
          symbol: sym,
          relativeVolume: round(1 + rand() * 3, 2),
          isEtf: ETFS.has(sym),
        })),
      });

    case 'optionGreeks': {
      const s = st(symbol);
      const dte = 25 + Math.floor(rand() * 30);
      const strike = Math.round(s.price / 5) * 5;
      const premium = round(s.price * 0.03, 2);
      const type = args.type === 'put' ? 'put' : 'call';
      const optionSymbol = `${symbol}${daysFromNow(dte).replace(/-/g, '')}${type === 'put' ? 'P' : 'C'}${strike}`;
      const delta = round((type === 'put' ? -0.4 : 0.4) + gauss() * 0.02, 3);
      const theta = round(-premium * 0.015, 3);
      if (!contracts.has(optionSymbol)) {
        contracts.set(optionSymbol, {
          underlying: symbol, strike, expiration: daysFromNow(dte), type,
          s0: s.price, p0: premium, delta, theta, t0: Date.now(),
        });
      }
      return JSON.stringify({
        symbol, optionSymbol, type, strike, expiration: daysFromNow(dte),
        delta, theta, gamma: 0.02, vega: 0.12,
        impliedVolatility: round(0.25 + rand() * 0.2, 3),
        ivRank: Math.round(10 + rand() * 60), // sometimes above the maxIvRank gate
        dte,
        bid: round(premium * 0.98, 2), ask: round(premium * 1.02, 2),
      });
    }

    case 'optionQuote': {
      const optionSymbol = String(args.optionSymbol);
      const c = contracts.get(optionSymbol);
      const s = st(String(args.underlying ?? c?.underlying ?? symbol));
      if (!c) return JSON.stringify({ optionSymbol, bid: 0.05, ask: 0.1, delta: 0.4, theta: -0.03, gamma: 0.02, vega: 0.1, impliedVolatility: 0.3, ivRank: 30, dte: 30 });
      const daysElapsed = (Date.now() - c.t0) / 86_400_000;
      // Simulated time runs faster than wall-clock so smoke tests see premium decay / DTE shrink.
      const mid = Math.max(0.05, c.p0 + c.delta * (s.price - c.s0) + c.theta * daysElapsed * 50);
      const dte = Math.max(0, Math.round((Date.parse(c.expiration) - Date.now()) / 86_400_000));
      return JSON.stringify({
        optionSymbol, bid: round(mid * 0.98, 2), ask: round(mid * 1.02, 2),
        delta: c.delta, theta: c.theta, gamma: 0.02, vega: 0.12, impliedVolatility: 0.3, ivRank: 30, dte,
      });
    }

    case 'cryptoQuotes':
      return JSON.stringify({
        quotes: symbols.map((sym) => {
          const s = step(sym);
          return {
            ...quoteOf(sym, s),
            change5mPct: round(s.mom * 100 * 3, 3),
            change1hPct: round(s.mom * 100 * 12, 3),
            rsi14: round(50 + 42 * Math.tanh(s.mom / (s.vol * 2)), 2),
            volumeVsAvg: round(s.volumeVsAvg, 2),
          };
        }),
      });

    case 'historicals': {
      const sym = symbol;
      const base = BASE[sym] ?? 100;
      const bars: { date: string; open: number; high: number; low: number; close: number; volume: number }[] = [];
      let price = base * 0.85;
      const dailyVol = 0.015;
      for (let i = 0; i < 260; i++) {
        const d = new Date(Date.now() - (260 - i) * 86_400_000);
        const day = d.getDay();
        if (day === 0 || day === 6) continue;
        const ret = 0.0003 + gauss() * dailyVol;
        const open = price;
        price *= 1 + ret;
        const high = Math.max(open, price) * (1 + Math.abs(gauss()) * dailyVol * 0.5);
        const low = Math.min(open, price) * (1 - Math.abs(gauss()) * dailyVol * 0.5);
        bars.push({
          date: d.toISOString().slice(0, 10),
          open: round(open), high: round(high), low: round(low), close: round(price),
          volume: Math.round(1_000_000 * (0.5 + rand() * 1.5)),
        });
      }
      return JSON.stringify({ symbol: sym, bars });
    }

    case 'review':
      return JSON.stringify({ ok: true, alerts: [], estimatedPrice: 0 });

    default:
      return '{}';
  }
}

/** Test hook for the simulator: pin a symbol's price. */
export function simSetPrice(symbol: string, price: number): void {
  st(symbol).price = price;
}

/** Test hook: rewrite a simulated option's underlying reference so its premium jumps. */
export function simSetContractPremium(optionSymbol: string, premium: number): void {
  const c = contracts.get(optionSymbol);
  if (!c) return;
  c.p0 = premium;
  c.s0 = st(c.underlying).price;
  c.t0 = Date.now();
}
