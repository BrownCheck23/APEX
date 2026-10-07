// Assertion-based verification of APEX's core guarantees. No network, no API spend.
// Usage: APEX_OFFLINE_SIM=true PAPER_TRADING=true npx tsx scripts/verify.ts
import { config, redact } from '../src/config/index.js';
import { getStrategyConfig, saveStrategyConfig } from '../src/config/strategy.js';
import { computeOFI, computeVWAPDeviation, compute12MonthReturn, compute200DaySMA, computeRSI14, isEntrySignal } from '../src/data/signals.js';
import {
  assertAllowed, buildArgs, CapabilityUnavailable, normalizePlaced, normalizePortfolio, normalizePositions, normalizeQuotes,
  normalizeReview, placeCryptoOrder, placeOptionOrder, placeOrder, normalizeHistoricals,
} from '../src/data/robinhood.js';
import { tokenFromResponse } from '../src/data/robinhood-auth.js';
import fs from 'node:fs';
import path from 'node:path';
import { getExecutionEngine } from '../src/execution/engine.js';
import { LiveExecutionEngine } from '../src/execution/live.js';
import { PaperExecutionEngine } from '../src/execution/paper.js';
import { runEvaluationIfNeeded, mergeUpdates } from '../src/learning/evaluator.js';
import { getDb, getTotalTradeCount, initializeDatabase, logTrade, updateTradePnl } from '../src/learning/logger.js';
import { KillSwitch } from '../src/risk/killswitch.js';
import { getPortfolioState, getPosition, initializePaperPortfolio, openPosition, updatePositionPrice } from '../src/portfolio/tracker.js';
import { closeTrackedPosition, logExecution, openTrackedPosition } from '../src/strategy/common.js';
import type { JevFilter, PortfolioState, Position, TradeRecord } from '../src/types.js';

if (!config.paperMode || !config.offlineSim) throw new Error('verify.ts requires PAPER_TRADING=true and APEX_OFFLINE_SIM=true');

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${detail}`); }
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const section = (s: string) => console.log(`\n${s}`);

initializeDatabase(':memory:');
const cfg = getStrategyConfig();

// ── Paper portfolio and a simulated buy + close ───────────────────────────────
section('Paper portfolio');
initializePaperPortfolio(100000);
check('starts at $100,000', getPortfolioState().totalValue === 100000 && getPortfolioState().cash === 100000);

const quote = { price: 100, bidPrice: 99.9, askPrice: 100.1 };
const engine = getExecutionEngine();
check('paper mode selects the paper engine', engine instanceof PaperExecutionEngine);

const buy = await engine.placeEquityOrder({ symbol: 'SPY', side: 'buy', quantity: 10, type: 'market', quote });
check('buy fills at ask + 0.1% slippage', near(buy.filledPrice, 100.1 * 1.001), `got ${buy.filledPrice}`);
const entryRow = {
  symbol: 'SPY', assetClass: 'equity' as const, regime: 'trending_bullish', action: 'buy', price: 100,
  state: {}, quantity: 10, fillPrice: buy.filledPrice, orderId: buy.orderId, reason: 'test',
  filter: { confidence: 0.8, isCoherent: true, regime: 'trending_bullish' },
};
const entryId = logExecution(entryRow);
openTrackedPosition(entryRow, entryId);
const afterBuy = getPortfolioState();
check('cash drops by the notional', near(afterBuy.cash, 100000 - buy.filledPrice * 10));
check('one open position', afterBuy.openPositions.length === 1);

updatePositionPrice('SPY', 110);
check('unrealised P&L marks to market', near(getPosition('SPY')!.unrealizedPnl, (110 - buy.filledPrice) * 10));

const sell = await engine.placeEquityOrder({ symbol: 'SPY', side: 'sell', quantity: 10, type: 'market', quote: { price: 110, bidPrice: 109.9, askPrice: 110.1 } });
check('sell fills at bid - 0.1% slippage', near(sell.filledPrice, 109.9 * 0.999));
const pnl = closeTrackedPosition({ ...entryRow, price: 110, fillPrice: sell.filledPrice, orderId: sell.orderId, reason: 'test close' });
const expectedPnl = (sell.filledPrice - buy.filledPrice) * 10;
check('realised P&L is exact', near(pnl, expectedPnl), `${pnl} vs ${expectedPnl}`);
const end = getPortfolioState();
check('portfolio value = start + P&L', near(end.totalValue, 100000 + expectedPnl));
check('trade count 1, win count 1, win rate 100%', end.tradeCount === 1 && end.winCount === 1 && end.winRate === 1);
const row = getDb().prepare('SELECT pnl FROM trades WHERE id = ?').get(entryId) as { pnl: number };
check('entry row in SQLite carries the P&L', near(row.pnl, expectedPnl));
check('completed-trade count = 1 (exit audit row not double counted)', getTotalTradeCount() === 1);

// short
initializePaperPortfolio(100000);
const shortRow = { ...entryRow, symbol: 'QQQ', action: 'sell' as const };
openTrackedPosition({ ...shortRow, fillPrice: 200 }, logExecution({ ...shortRow, fillPrice: 200 }));
check('short opens: cash rises by proceeds', near(getPortfolioState().cash, 100000 + 200 * 10));
check('short value net of liability = start', near(getPortfolioState().totalValue, 100000));
updatePositionPrice('QQQ', 190);
check('short profits when price falls', near(getPortfolioState().totalPnl, 100));

// ── Hard constraints ─────────────────────────────────────────────────────────
section('Hard constraints');
for (const [name, fn] of [
  ['placeOrder', () => placeOrder({ accountNumber: 'x', symbol: 'SPY', side: 'buy', quantity: '1', type: 'market' })],
  ['placeOptionOrder', () => placeOptionOrder({ accountNumber: 'x', optionSymbol: 'X', side: 'buy', quantity: '1', type: 'market' })],
  ['placeCryptoOrder', () => placeCryptoOrder({ accountNumber: 'x', symbol: 'BTC', side: 'buy', quantity: '1', type: 'market' })],
] as const) {
  let blocked = false;
  try { await fn(); } catch (e) { blocked = /paper trading mode/.test((e as Error).message); }
  check(`${name} refuses in paper mode`, blocked);
}
let liveBlocked = false;
try { await new LiveExecutionEngine().placeEquityOrder({ symbol: 'SPY', side: 'buy', quantity: 1, type: 'market' }); } catch (e) { liveBlocked = /paper mode/.test((e as Error).message); }
check('LiveExecutionEngine refuses in paper mode', liveBlocked);
check('secrets are redacted from log text', !redact('key sk-ant-api03-abcdef123456 here').includes('abcdef'));

// ── Kill switch ──────────────────────────────────────────────────────────────
section('Kill switch');
const pf = (pct: number): PortfolioState => ({
  totalValue: 100000 * (1 + pct), startingValue: 100000, totalPnl: 100000 * pct, totalPnlPct: pct,
  todayPnl: 0, openPositions: [], cash: 0, tradeCount: 0, winCount: 0, winRate: 0,
});
{
  const ks = new KillSwitch(() => {});
  check('-4.9% does nothing', !ks.check(pf(-0.049), []).triggered);
  const soft = ks.check(pf(-0.051), []);
  check('-5.1% soft stop', soft.level === 'soft' && soft.triggered && soft.canResume);
  await new Promise((r) => setTimeout(r, 50));
  check('soft stop resumes after evaluation', !ks.isActive());
  ks.dispose();
}
{
  let exited = 0;
  const ks = new KillSwitch(() => { exited++; });
  const hard = ks.check(pf(-0.101), []);
  check('-10.1% hard stop, no resume', hard.level === 'hard' && !hard.canResume && exited === 1);
  ks.check(pf(0), []);
  check('hard stop stays latched', ks.isActive());
}
{
  const ks = new KillSwitch(() => {});
  const decisions = (conf: number, from: number): TradeRecord[] => Array.from({ length: 20 }, (_, i) => ({
    id: from + i, timestamp: '', symbol: 'X', assetClass: 'equity', regime: 'ranging', action: 'hold', quantity: 0, price: 1,
    notionalValue: 0, pnl: null, pnlPct: null, confidence: conf, shouldTradeScore: 0, riskScore: 0, stateSnapshot: '{}', paperMode: true, orderId: null,
  }));
  check('healthy confidence does not trip', !ks.check(pf(0), decisions(0.8, 1)).triggered);
  check('19 low-confidence decisions are not enough', !ks.check(pf(0), decisions(0.4, 100).slice(1)).triggered);
  const c = ks.check(pf(0), decisions(0.4, 100));
  check('20 decisions averaging < 0.52 trips the confidence stop', c.level === 'confidence' && c.canResume);
  ks.dispose();
}

// ── Evaluator ────────────────────────────────────────────────────────────────
section('Self-improvement evaluator');
{
  const db = getDb();
  db.exec('DELETE FROM trades; DELETE FROM kv;');
  saveStrategyConfig({ ...getStrategyConfig(), version: 1 });
  const add = (n: number) => {
    for (let i = 0; i < n; i++) {
      const id = logTrade({
        timestamp: new Date().toISOString(), symbol: 'SPY', assetClass: 'equity', regime: 'trending_bullish', action: 'buy', quantity: 1, price: 450,
        notionalValue: 450, pnl: null, pnlPct: null, confidence: 0.7, shouldTradeScore: 1, riskScore: 0,
        stateSnapshot: JSON.stringify({ state: { momentum12m: 0.15, rsi14: 52, sma200: 420, price: 450 } }), paperMode: true, orderId: 'x',
      });
      updateTradePnl(id, i % 2 ? 5 : -8, i % 2 ? 5 : -8);
    }
  };
  add(49);
  await runEvaluationIfNeeded();
  check('does not fire at 49 trades', getStrategyConfig().version === 1);
  add(1);
  const before = getStrategyConfig();
  await runEvaluationIfNeeded();
  const after = getStrategyConfig();
  check('fires at 50 trades and bumps the version', after.version === 2, `v${after.version}`);
  check('confidenceThreshold moved by <= 20%', Math.abs(after.confidenceThreshold / before.confidenceThreshold - 1) <= 0.2 + 1e-9);
  await runEvaluationIfNeeded();
  check('does not re-fire while the count sits at 50', getStrategyConfig().version === 2);
  add(50);
  await runEvaluationIfNeeded();
  check('fires again at 100', getStrategyConfig().version === 3);
}
{
  const c = getStrategyConfig();
  const m = mergeUpdates(c, { confidenceThreshold: 0.99, positionSizingFactor: 0.01, featureWeights: { ofi: 9 }, minCoherenceScore: NaN, rsiLowerBound: 999 } as never);
  check('proposals are clamped to range and the 20% step', m.confidenceThreshold <= 0.9 && m.confidenceThreshold <= c.confidenceThreshold * 1.2 + 1e-9 && m.positionSizingFactor >= c.positionSizingFactor * 0.8 - 1e-9);
  check('evaluator can only change the five tunable fields (no featureWeights)', !('featureWeights' in m) && m.rsiLowerBound <= 45 && m.rsiUpperBound <= 80);
  check('garbage values are ignored', m.minCoherenceScore === c.minCoherenceScore);
}

// ── Deterministic entry signals ───────────────────────────────────────────────
section('Deterministic entry signals (daily bar math)');
const makePrices = (n: number, startPrice = 100, dailyReturn = 0.001): number[] =>
  Array.from({ length: n }, (_, i) => startPrice * (1 + dailyReturn) ** i);

const up = makePrices(260, 400, 0.001);
const down = makePrices(260, 400, -0.001);

check('compute12MonthReturn: positive trend', compute12MonthReturn(up) > 0);
check('compute12MonthReturn: negative trend', compute12MonthReturn(down) < 0);
check('compute12MonthReturn: needs 253 bars', compute12MonthReturn(up.slice(0, 252)) === 0);

const sma200 = compute200DaySMA(up);
check('compute200DaySMA: below current price in uptrend', sma200 < up[up.length - 1] && sma200 > 0);
check('compute200DaySMA: needs 200 bars', compute200DaySMA(up.slice(0, 199)) === 0);

const rsiFlat = computeRSI14(makePrices(20, 100, 0));
const rsiUp = computeRSI14(makePrices(20, 100, 0.01));
const rsiDown = computeRSI14(makePrices(20, 100, -0.01));
check('computeRSI14: flat series returns ~50', rsiFlat > 45 && rsiFlat < 55, `${rsiFlat}`);
check('computeRSI14: uptrend > 50', rsiUp > 50, `${rsiUp}`);
check('computeRSI14: downtrend < 50', rsiDown < 50, `${rsiDown}`);
check('computeRSI14: needs 15 bars', computeRSI14(makePrices(14, 100, 0.01)) === 50);

const gentle = makePrices(260, 400, 0.0003);
const sig = isEntrySignal(gentle);
check('isEntrySignal: all three components', typeof sig.momentum === 'boolean' && typeof sig.trend === 'boolean' && typeof sig.rsi === 'boolean');
check('isEntrySignal.all = momentum AND trend AND rsi', sig.all === (sig.momentum && sig.trend && sig.rsi));

const noMomentum = isEntrySignal(down);
check('isEntrySignal: negative momentum blocks entry', !noMomentum.momentum && !noMomentum.all);

// ── Signals utilities ─────────────────────────────────────────────────────────
section('Signals utilities');
check('OFI', near(computeOFI({ bidDepth: 300, askDepth: 100 }), 0.5) && computeOFI({ bidDepth: 0, askDepth: 0 }) === 0);
check('VWAP deviation', near(computeVWAPDeviation(101, 100), 1));

// ── Direct MCP client: guards, argument building, normalisers ────────────────
section('Robinhood MCP client (no network)');
const throws = (fn: () => unknown, re: RegExp) => { try { fn(); return false; } catch (e) { return re.test((e as Error).message); } };
check('allow-list: read tools pass', !throws(() => assertAllowed('get_equity_quotes'), /./));
check('allow-list: historicals pass', !throws(() => assertAllowed('get_equity_historicals'), /./));
check('allow-list: unknown tools are refused', throws(() => assertAllowed('delete_everything'), /allow-list/));
check('allow-list: watchlist writes and cancels are not callable', throws(() => assertAllowed('add_to_watchlist'), /allow-list/) && throws(() => assertAllowed('cancel_equity_order'), /allow-list/));
check('allow-list: place_* refused in paper mode even with opt-in', throws(() => assertAllowed('place_equity_order', 'place_equity_order'), /paper trading mode/));

const quoteSchema = { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } }, required: ['symbols'] };
check('buildArgs: symbols -> array parameter', JSON.stringify(buildArgs('t', quoteSchema, { symbols: ['SPY', 'QQQ'] })) === '{"symbols":["SPY","QQQ"]}');
check('buildArgs: array -> comma string when the schema wants a string', buildArgs('t', { properties: { tickers: { type: 'string' } } }, { symbols: ['SPY', 'QQQ'] }).tickers === 'SPY,QQQ');
const orderSchema = {
  type: 'object',
  properties: { account_number: { type: 'string' }, symbol: { type: 'string' }, side: { enum: ['BUY', 'SELL'] }, quantity: { type: 'string' }, order_type: { type: 'string' } },
  required: ['account_number', 'symbol', 'side', 'quantity', 'order_type', 'time_in_force'],
};
check('buildArgs: refuses to guess a required order field it cannot fill', throws(() => buildArgs('place_equity_order', orderSchema, { account: 'A', symbol: 'SPY', side: 'buy', quantity: '1', type: 'market' }), /time_in_force/));
const okSchema = { ...orderSchema, required: ['account_number', 'symbol', 'side', 'quantity', 'order_type'] };
const built = buildArgs('place_equity_order', okSchema, { account: 'A1', symbol: 'SPY', side: 'buy', quantity: 3, type: 'market' });
check('buildArgs: maps aliases, matches enum case, stringifies numbers', built.account_number === 'A1' && built.side === 'BUY' && built.quantity === '3' && built.order_type === 'market');
check('buildArgs: rejects a value outside an enum', throws(() => buildArgs('t', okSchema, { account: 'A', symbol: 'S', side: 'hold', quantity: 1, type: 'market' }), /not one of/));

const q = JSON.parse(normalizeQuotes({ results: [{ symbol: 'spy', last_trade_price: '450.12', bid_price: '450.1', ask_price: '450.14' }, { ticker: 'QQQ', bid: 380, ask: 380.2 }, { symbol: 'BAD' }] }));
check('normalizeQuotes: field aliases, string numbers, mid fallback, drops unusable rows', q.quotes.length === 2 && q.quotes[0].symbol === 'SPY' && q.quotes[0].price === 450.12 && near(q.quotes[1].price, 380.1));
const pfOut = JSON.parse(normalizePortfolio({ equity: '$12,345.67', buying_power: '5000' }));
check('normalizePortfolio: total, cash falls back to buying power', pfOut.totalValue === 12345.67 && pfOut.cash === 5000);
check('normalizePortfolio: no total -> error, not a guess', throws(() => normalizePortfolio({ foo: 1 }), /total value/));
const pos = JSON.parse(normalizePositions({ positions: [{ symbol: 'SPY', quantity: '2', average_buy_price: '400', current_price: '420' }, { symbol: 'X', quantity: '0' }] }));
check('normalizePositions: keeps held lots only', pos.positions.length === 1 && pos.positions[0].averagePrice === 400 && pos.positions[0].currentPrice === 420);
const rv = JSON.parse(normalizeReview({ warnings: ['Price is far from market', { level: 'info', message: 'ok' }], estimated_cost: '99.5' }));
check('normalizeReview: string and object alerts, estimate', rv.alerts.length === 2 && rv.alerts[0].severity === 'warning' && rv.alerts[1].severity === 'info' && rv.estimatedPrice === 99.5);
check('normalizePlaced: needs an order id', JSON.parse(normalizePlaced({ id: 'abc', state: 'filled', average_price: '10' })).orderId === 'abc' && throws(() => normalizePlaced({}), /order id/));
check('CapabilityUnavailable names the capability', new CapabilityUnavailable('Level 2 order book').message.includes('Level 2 order book'));

const histRaw = JSON.parse(normalizeHistoricals({ historicals: [
  { begins_at: '2025-01-02', open_price: '450', high_price: '452', low_price: '449', close_price: '451', volume: 50000000 },
  { begins_at: '2025-01-03', close_price: '0' },
], symbol: 'SPY' }));
check('normalizeHistoricals: parses bars, drops zero-close', histRaw.bars.length === 1 && histRaw.bars[0].close === 451 && histRaw.bars[0].date === '2025-01-02');

const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []));
const importers = walk('src').filter((f) => /from '@anthropic-ai\/sdk'/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.basename(f));
check('only evaluator.ts imports the Anthropic SDK', importers.length === 1 && importers[0] === 'evaluator.ts', importers.join(','));

section('Cost controls and token handling');
check('options and crypto flags default on', config.enableOptions && config.enableCrypto);
const prev = { clientId: 'c', redirectUri: 'r', tokenEndpoint: 't', refreshToken: 'old-refresh', scope: 'internal' };
check('token refresh keeps the old refresh token when none is rotated in', tokenFromResponse({ access_token: 'a', expires_in: 100 }, prev).refreshToken === 'old-refresh');
check('token refresh adopts a rotated refresh token', tokenFromResponse({ access_token: 'a', refresh_token: 'new' }, prev).refreshToken === 'new');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
