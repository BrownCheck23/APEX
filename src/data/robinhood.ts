import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from '../config/index.js';
import { logger } from '../logging.js';
import { getAccessToken } from './robinhood-auth.js';
import { isRecord, toNumOrNull } from './parse.js';
import { simulate, type SimKind } from './sim.js';

/**
 * Direct client for Robinhood's MCP server (https://agent.robinhood.com/mcp/trading) using
 * @modelcontextprotocol/sdk and the OAuth token from robinhood-auth.ts. No LLM sits in this path: every call
 * here is a plain MCP tool call, and Claude is used only by learning/evaluator.ts.
 *
 * The server's published tool list (checked Aug 2026, unverified since) is equities only: accounts, portfolio,
 * positions, quotes, orders, search, watchlists, review/place/cancel equity order. It has NO Level 2 book,
 * technical indicators, earnings, scanner, options or crypto tools. Those wrappers throw CapabilityUnavailable
 * instead of inventing data. Run `npm run robinhood:tools` to see what the server actually offers.
 *
 * Order safety: only tools on an explicit allow-list can be called at all, a place_* tool can only run in live
 * mode after the caller has opted in for that specific tool, and a failed place_* call is never retried.
 */

const MCP_URL = 'https://agent.robinhood.com/mcp/trading';
const CALL_TIMEOUT_MS = 30_000;

export const PLACE_TOOLS = ['place_equity_order', 'place_option_order', 'place_crypto_order'] as const;
export type PlaceTool = (typeof PLACE_TOOLS)[number];

const READ_TOOLS = new Set(['get_accounts', 'get_portfolio', 'get_equity_positions', 'get_equity_quotes', 'get_equity_orders', 'get_equity_historicals', 'search', 'get_watchlists']);
const REVIEW_TOOLS = new Set(['review_equity_order', 'review_option_order']);

/** Thrown for data this MCP server does not provide. Callers must fail closed, not substitute made-up values. */
export class CapabilityUnavailable extends Error {
  constructor(readonly capability: string) {
    super(
      `${capability} is not available from the Robinhood MCP server (it exposes equity account, quote and order tools only). ` +
      `Run "npm run robinhood:tools" to list what it offers.`,
    );
    this.name = 'CapabilityUnavailable';
  }
}

// ─── Connection ──────────────────────────────────────────────────────────────

export interface ToolInfo { name: string; description?: string; inputSchema: Record<string, unknown> }
interface Conn { client: Client; tools: Map<string, ToolInfo> }

let conn: Conn | null = null;
let connecting: Promise<Conn> | null = null;

async function openConnection(): Promise<Conn> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    // Inject the bearer token per request so a refreshed token is picked up without reconnecting.
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${await getAccessToken()}`);
      return fetch(url, { ...init, headers });
    },
  });
  const client = new Client({ name: 'apex', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const { tools } = await client.listTools();
  return { client, tools: new Map(tools.map((t) => [t.name, t as ToolInfo])) };
}

async function getConn(): Promise<Conn> {
  if (conn) return conn;
  connecting ??= openConnection()
    .then((c) => { conn = c; return c; })
    .finally(() => { connecting = null; });
  return connecting;
}

async function resetConn(): Promise<void> {
  const old = conn;
  conn = null;
  await old?.client.close().catch(() => {});
}

export async function closeRobinhood(): Promise<void> {
  await resetConn();
}

/** Tools the server really exposes, with their input schemas (used by `npm run robinhood:tools`). */
export async function listRobinhoodTools(): Promise<ToolInfo[]> {
  return [...(await getConn()).tools.values()];
}

const isAuthOrSession = (err: unknown) => /401|unauthori[sz]ed|invalid[_ ]token|session/i.test((err as Error)?.message ?? '');

// ─── Tool calls ──────────────────────────────────────────────────────────────

export function assertAllowed(name: string, allowPlace?: PlaceTool): void {
  if ((PLACE_TOOLS as readonly string[]).includes(name)) {
    if (config.paperMode) throw new Error(`${name} called in paper trading mode — use paper simulator`);
    if (allowPlace !== name) throw new Error(`${name} requires explicit opt-in`);
    return;
  }
  if (!READ_TOOLS.has(name) && !REVIEW_TOOLS.has(name)) throw new Error(`Tool "${name}" is not on APEX's allow-list`);
}

/** Pulls the payload out of an MCP tool result: structuredContent if present, else JSON text, else the raw text. */
function payloadOf(result: { content?: unknown; structuredContent?: unknown; isError?: boolean }, tool: string): unknown {
  const blocks = Array.isArray(result.content) ? (result.content as Array<{ type: string; text?: string }>) : [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
  if (result.isError) throw new Error(`${tool} failed: ${text.slice(0, 300) || 'unknown error'}`);
  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

export async function callTool(name: string, args: Record<string, unknown>, opts: { allowPlace?: PlaceTool } = {}): Promise<unknown> {
  assertAllowed(name, opts.allowPlace);
  if (config.offlineSim) throw new Error('offline simulation never reaches the network');

  const isPlace = (PLACE_TOOLS as readonly string[]).includes(name);
  for (let attempt = 0; ; attempt++) {
    try {
      const c = await getConn();
      if (!c.tools.has(name)) throw new CapabilityUnavailable(`Tool ${name}`);
      const result = await c.client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
      return payloadOf(result as Parameters<typeof payloadOf>[0], name);
    } catch (err) {
      // One reconnect with a force-refreshed token for expired tokens or sessions. Never for orders:
      // retrying a place_* call whose first attempt may have reached the broker could double the order.
      if (attempt === 0 && !isPlace && isAuthOrSession(err)) {
        logger.warn(`${name}: connection or token problem; reconnecting once`);
        await resetConn();
        await getAccessToken({ forceRefresh: true }).catch(() => {});
        continue;
      }
      throw err;
    }
  }
}

// ─── Schema-driven argument building ─────────────────────────────────────────

/** Canonical field -> parameter names the server might use for it. */
const ALIASES = {
  symbols: ['symbols', 'tickers', 'symbol_list'],
  symbol: ['symbol', 'ticker', 'instrument_symbol'],
  account: ['account_number', 'account', 'account_id', 'accountNumber'],
  side: ['side', 'direction'],
  quantity: ['quantity', 'qty', 'shares'],
  type: ['type', 'order_type', 'orderType'],
  limitPrice: ['limit_price', 'limitPrice', 'price'],
} as const;
type Canonical = Partial<Record<keyof typeof ALIASES, unknown>>;

function schemaTypes(prop: Record<string, unknown>): string[] {
  const t = prop.type;
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  const any = (prop.anyOf ?? prop.oneOf) as Array<Record<string, unknown>> | undefined;
  return any ? any.flatMap(schemaTypes) : [];
}

function coerce(value: unknown, prop: Record<string, unknown>, label: string): unknown {
  const types = schemaTypes(prop);
  const enumValues = Array.isArray(prop.enum) ? (prop.enum as unknown[]) : null;
  if (enumValues) {
    const hit = enumValues.find((e) => String(e).toLowerCase() === String(value).toLowerCase());
    if (hit === undefined) throw new Error(`${label}: "${String(value)}" is not one of ${enumValues.join(', ')}`);
    return hit;
  }
  if (types.includes('array') && !Array.isArray(value)) return [value];
  if (Array.isArray(value) && !types.includes('array') && types.includes('string')) return value.join(',');
  if ((types.includes('number') || types.includes('integer')) && !types.includes('string')) {
    return typeof value === 'string' ? Number(value) : value;
  }
  if (types.includes('string') && typeof value !== 'string') return String(value);
  return value;
}

/**
 * Maps canonical values onto a tool's real input schema. Parameters the schema does not have are dropped, and
 * a *required* parameter that cannot be filled is an error: APEX never guesses at a missing order field.
 */
export function buildArgs(tool: string, schema: Record<string, unknown>, canonical: Canonical): Record<string, unknown> {
  const props = (isRecord(schema.properties) ? schema.properties : {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const args: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(canonical)) {
    if (value === undefined || value === null) continue;
    const names = ALIASES[field as keyof typeof ALIASES] as readonly string[];
    const name = names.find((a) => a in props);
    if (name) args[name] = coerce(value, props[name], `${tool}.${name}`);
  }
  const unfilled = required.filter((r) => !(r in args));
  if (unfilled.length > 0) {
    throw new Error(`${tool}: cannot fill required parameter(s) ${unfilled.join(', ')}. Run "npm run robinhood:tools" and extend ALIASES in robinhood.ts.`);
  }
  return args;
}

async function call(name: string, canonical: Canonical, opts: { allowPlace?: PlaceTool } = {}): Promise<unknown> {
  assertAllowed(name, opts.allowPlace); // refuse before connecting if the call is not permitted at all
  const c = await getConn();
  const info = c.tools.get(name);
  if (!info) throw new CapabilityUnavailable(`Tool ${name}`);
  return callTool(name, buildArgs(name, info.inputSchema, canonical), opts);
}

// ─── Tolerant normalisers (server field names -> APEX's canonical JSON) ──────

const pick = (o: Record<string, unknown>, keys: string[]): unknown => keys.map((k) => o[k]).find((v) => v !== undefined && v !== null);

function items(payload: unknown, preferred: string[]): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  for (const k of preferred) if (Array.isArray(payload[k])) return (payload[k] as unknown[]).filter(isRecord);
  const firstArray = Object.values(payload).find(Array.isArray);
  return firstArray ? (firstArray as unknown[]).filter(isRecord) : [];
}

export function normalizeQuotes(payload: unknown): string {
  const quotes = items(payload, ['quotes', 'results', 'data']).flatMap((q) => {
    const symbol = pick(q, ['symbol', 'ticker']);
    const bid = toNumOrNull(pick(q, ['bid_price', 'bid', 'bidPrice']));
    const ask = toNumOrNull(pick(q, ['ask_price', 'ask', 'askPrice']));
    const last = toNumOrNull(pick(q, ['last_trade_price', 'price', 'last', 'last_price', 'mark_price']));
    const price = last ?? (bid !== null && ask !== null ? (bid + ask) / 2 : null);
    if (typeof symbol !== 'string' || price === null) return [];
    return [{
      symbol: symbol.toUpperCase(), price, bid: bid ?? price, ask: ask ?? price,
      volume: toNumOrNull(pick(q, ['volume', 'last_trade_size'])) ?? 0,
      timestamp: String(pick(q, ['updated_at', 'timestamp', 'last_trade_time']) ?? new Date().toISOString()),
    }];
  });
  return JSON.stringify({ quotes });
}

export function normalizePortfolio(payload: unknown): string {
  const p = isRecord(payload) ? payload : {};
  const total = toNumOrNull(pick(p, ['total_value', 'portfolio_value', 'total_equity', 'equity', 'market_value', 'totalValue']));
  if (total === null) throw new Error('get_portfolio: could not find a total value in the response');
  const buyingPower = toNumOrNull(pick(p, ['buying_power', 'buyingPower']));
  const cash = toNumOrNull(pick(p, ['cash', 'cash_balance', 'available_cash', 'withdrawable_amount']));
  return JSON.stringify({ totalValue: total, cash: cash ?? buyingPower ?? 0, buyingPower: buyingPower ?? cash ?? 0 });
}

export function normalizePositions(payload: unknown): string {
  const positions = items(payload, ['positions', 'results', 'data']).flatMap((p) => {
    const symbol = pick(p, ['symbol', 'ticker']);
    const quantity = toNumOrNull(pick(p, ['quantity', 'shares', 'qty']));
    if (typeof symbol !== 'string' || quantity === null || quantity <= 0) return [];
    const avg = toNumOrNull(pick(p, ['average_buy_price', 'average_price', 'avg_cost', 'cost_basis_per_share'])) ?? 0;
    return [{
      symbol: symbol.toUpperCase(), assetClass: 'equity', side: 'long', quantity, averagePrice: avg,
      currentPrice: toNumOrNull(pick(p, ['current_price', 'last_trade_price', 'price'])) ?? avg,
      openedAt: pick(p, ['created_at', 'updated_at']) ?? null,
    }];
  });
  return JSON.stringify({ positions });
}

export function normalizeReview(payload: unknown): string {
  const p = isRecord(payload) ? payload : {};
  const raw = pick(p, ['alerts', 'warnings', 'messages']);
  const alerts = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((a) =>
    isRecord(a)
      ? { severity: String(pick(a, ['severity', 'level', 'type']) ?? 'warning'), message: String(pick(a, ['message', 'text', 'description']) ?? 'alert') }
      : { severity: 'warning', message: String(a) },
  );
  return JSON.stringify({ ok: p.error === undefined, alerts, estimatedPrice: toNumOrNull(pick(p, ['estimated_price', 'estimated_cost', 'price', 'limit_price'])) });
}

export function normalizePlaced(payload: unknown): string {
  const p = isRecord(payload) ? payload : {};
  const id = pick(p, ['id', 'order_id', 'orderId']);
  if (id === undefined) throw new Error('place order: no order id in the response');
  return JSON.stringify({ orderId: String(id), state: pick(p, ['state', 'status']) ?? '', filledPrice: toNumOrNull(pick(p, ['average_price', 'filled_price', 'price'])) });
}

// ─── Wrappers used by the rest of APEX (they return canonical JSON strings) ──

const sim = (kind: SimKind, args: Record<string, unknown> = {}) => simulate(kind, args);

export async function getQuotes(symbols: string[]): Promise<string> {
  if (config.offlineSim) return sim('quotes', { symbols });
  return normalizeQuotes(await call('get_equity_quotes', { symbols }));
}

export async function getHistoricals(symbol: string, opts: { interval?: string; span?: string } = {}): Promise<string> {
  if (config.offlineSim) return sim('historicals', { symbol });
  // Call directly with raw args — interval/span are not in the ALIASES map.
  return normalizeHistoricals(await callTool('get_equity_historicals', {
    symbol, interval: opts.interval ?? 'day', span: opts.span ?? 'year',
  }));
}

export function normalizeHistoricals(payload: unknown): string {
  const r = isRecord(payload) ? payload : {};
  const raw = Array.isArray(r.historicals) ? r.historicals : Array.isArray(r.results) ? r.results : Array.isArray(payload) ? payload : [];
  const bars = (raw as unknown[]).filter(isRecord).map((b) => ({
    date: String(b.begins_at ?? b.date ?? ''),
    open: toNumOrNull(b.open_price ?? b.open) ?? 0,
    high: toNumOrNull(b.high_price ?? b.high) ?? 0,
    low: toNumOrNull(b.low_price ?? b.low) ?? 0,
    close: toNumOrNull(b.close_price ?? b.close) ?? 0,
    volume: toNumOrNull(b.volume) ?? 0,
  })).filter((b) => b.close > 0);
  return JSON.stringify({ symbol: String(r.symbol ?? ''), bars });
}

export async function getPortfolio(accountNumber: string): Promise<string> {
  if (config.offlineSim) return sim('portfolio');
  return normalizePortfolio(await call('get_portfolio', { account: accountNumber }));
}

export async function getPositions(accountNumber: string): Promise<string> {
  if (config.offlineSim) return sim('positions');
  return normalizePositions(await call('get_equity_positions', { account: accountNumber }));
}

export async function getTechnicalIndicators(symbol: string, _indicators: string[]): Promise<string> {
  if (config.offlineSim) return sim('indicators', { symbol });
  throw new CapabilityUnavailable('Technical indicators');
}

export async function getL2Book(symbols: string[]): Promise<string> {
  if (config.offlineSim) return sim('l2', { symbols });
  throw new CapabilityUnavailable('Level 2 order book');
}

export async function getEarnings(symbol: string): Promise<string> {
  if (config.offlineSim) return sim('earnings', { symbol });
  throw new CapabilityUnavailable('Earnings data');
}

export async function runScan(_scanId: string): Promise<string> {
  if (config.offlineSim) return sim('scan');
  throw new CapabilityUnavailable('Market scanner');
}

export async function getOptionGreeks(params: { symbol: string; targetDelta: number; minDte: number; maxDte: number; type?: 'call' | 'put' }): Promise<string> {
  if (config.offlineSim) return sim('optionGreeks', { symbol: params.symbol, type: params.type ?? 'call' });
  throw new CapabilityUnavailable('Options chains and Greeks');
}

export async function getOptionQuote(optionSymbol: string, underlying: string): Promise<string> {
  if (config.offlineSim) return sim('optionQuote', { optionSymbol, underlying });
  throw new CapabilityUnavailable('Option quotes');
}

export async function getCryptoQuotes(symbols: string[]): Promise<string> {
  if (config.offlineSim) return sim('cryptoQuotes', { symbols });
  throw new CapabilityUnavailable('Crypto quotes');
}

// ─── Order review and placement ──────────────────────────────────────────────

export async function reviewOrder(params: {
  accountNumber: string; symbol: string; side: 'buy' | 'sell'; quantity: string;
  type: 'market' | 'limit' | 'stop_market' | 'stop_limit'; limitPrice?: string;
}): Promise<string> {
  if (config.offlineSim) return sim('review');
  return normalizeReview(await call('review_equity_order', {
    account: params.accountNumber, symbol: params.symbol, side: params.side,
    quantity: params.quantity, type: params.type, limitPrice: params.limitPrice,
  }));
}

export async function reviewOptionOrder(_params: {
  accountNumber: string; optionSymbol: string; side: 'buy' | 'sell'; quantity: string; type: 'market' | 'limit'; limitPrice?: string;
}): Promise<string> {
  if (config.offlineSim) return sim('review');
  throw new CapabilityUnavailable('Option order review');
}

function assertLive(tool: PlaceTool): void {
  if (config.paperMode) throw new Error(`${tool} called in paper trading mode — use paper simulator`);
}

export async function placeOrder(params: {
  accountNumber: string; symbol: string; side: 'buy' | 'sell'; quantity: string; type: 'market' | 'limit'; limitPrice?: string;
}): Promise<string> {
  assertLive('place_equity_order');
  logger.warn(`LIVE equity order: ${params.side} ${params.quantity} ${params.symbol}`);
  return normalizePlaced(await call('place_equity_order', {
    account: params.accountNumber, symbol: params.symbol, side: params.side,
    quantity: params.quantity, type: params.type, limitPrice: params.limitPrice,
  }, { allowPlace: 'place_equity_order' }));
}

export async function placeOptionOrder(_params: {
  accountNumber: string; optionSymbol: string; side: 'buy' | 'sell'; quantity: string; type: 'market' | 'limit'; limitPrice?: string;
}): Promise<string> {
  assertLive('place_option_order');
  throw new CapabilityUnavailable('Option orders');
}

export async function placeCryptoOrder(_params: {
  accountNumber: string; symbol: string; side: 'buy' | 'sell'; quantity: string; type: 'market' | 'limit'; limitPrice?: string;
}): Promise<string> {
  assertLive('place_crypto_order');
  throw new CapabilityUnavailable('Crypto orders');
}

/** What APEX's strategies need that the wrappers above cannot provide, whatever the server lists. */
export const NOT_WIRED = [
  'Level 2 order book (legacy, not used by daily strategy)',
  'Technical indicators (computed locally from historicals)',
  'Earnings dates and analyst ratings',
  'Market scanner (universe is SPY+QQQ only)',
  'Options chains, Greeks and orders (disabled)',
  'Crypto quotes and orders (disabled)',
] as const;

/** Startup report for real mode: the server's tools, and any that look like they could fill a gap. */
export async function describeCapabilities(): Promise<{ tools: string[]; candidates: string[] }> {
  const tools = (await listRobinhoodTools()).map((t) => t.name);
  const known = new Set([...READ_TOOLS, ...REVIEW_TOOLS, ...PLACE_TOOLS, 'cancel_equity_order', 'add_to_watchlist', 'update_watchlist']);
  return { tools, candidates: tools.filter((t) => !known.has(t)) };
}
