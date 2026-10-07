import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import type { PortfolioState, TradeRecord, AssetClass } from '../types.js';

/**
 * Row model
 *  - Every decision is a row (rule 7). A decision that did not result in an order has quantity = 0
 *    and the reason it was skipped inside state_snapshot.
 *  - An executed entry (buy/sell) is a row whose pnl stays NULL until the position closes; closing
 *    calls updateTradePnl() on that entry row, which makes it a completed "trade".
 *  - The closing order is logged as its own row with action = 'exit' for the audit trail.
 *  - A completed trade = quantity > 0, action != 'exit', pnl NOT NULL, in the current paper/live mode.
 */

let db: Database.Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  regime TEXT NOT NULL,
  action TEXT NOT NULL,
  quantity REAL NOT NULL,
  price REAL NOT NULL,
  notional_value REAL NOT NULL,
  pnl REAL,
  pnl_pct REAL,
  confidence REAL NOT NULL,
  should_trade_score REAL NOT NULL,
  risk_score REAL NOT NULL,
  state_snapshot TEXT NOT NULL,
  paper_mode INTEGER NOT NULL,
  order_id TEXT
);

CREATE TABLE IF NOT EXISTS strategy_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  config_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  total_value REAL NOT NULL,
  total_pnl REAL NOT NULL,
  total_pnl_pct REAL NOT NULL,
  trade_count INTEGER NOT NULL,
  win_rate REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function initializeDatabase(dbPath: string = config.dbPath): Database.Database {
  if (db) return db;
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

export function getDb(): Database.Database {
  return db ?? initializeDatabase();
}

/** Test helper: close and forget the connection. */
export function closeDatabase(): void {
  db?.close();
  db = null;
}

interface TradeRow {
  id: number;
  timestamp: string;
  symbol: string;
  asset_class: AssetClass;
  regime: string;
  action: string;
  quantity: number;
  price: number;
  notional_value: number;
  pnl: number | null;
  pnl_pct: number | null;
  confidence: number;
  should_trade_score: number;
  risk_score: number;
  state_snapshot: string;
  paper_mode: number;
  order_id: string | null;
}

function fromRow(r: TradeRow): TradeRecord {
  return {
    id: r.id,
    timestamp: r.timestamp,
    symbol: r.symbol,
    assetClass: r.asset_class,
    regime: r.regime,
    action: r.action,
    quantity: r.quantity,
    price: r.price,
    notionalValue: r.notional_value,
    pnl: r.pnl,
    pnlPct: r.pnl_pct,
    confidence: r.confidence,
    shouldTradeScore: r.should_trade_score,
    riskScore: r.risk_score,
    stateSnapshot: r.state_snapshot,
    paperMode: r.paper_mode === 1,
    orderId: r.order_id,
  };
}

/** Inserts a decision/trade row and returns its id. */
export function logTrade(trade: TradeRecord): number {
  const info = getDb()
    .prepare(
      `INSERT INTO trades (timestamp, symbol, asset_class, regime, action, quantity, price, notional_value,
         pnl, pnl_pct, confidence, should_trade_score, risk_score, state_snapshot, paper_mode, order_id)
       VALUES (@timestamp, @symbol, @assetClass, @regime, @action, @quantity, @price, @notionalValue,
         @pnl, @pnlPct, @confidence, @shouldTradeScore, @riskScore, @stateSnapshot, @paperMode, @orderId)`,
    )
    .run({ ...trade, paperMode: trade.paperMode ? 1 : 0 });
  return Number(info.lastInsertRowid);
}

/** Most recent n rows for the current paper/live mode, oldest first. Includes non-trade decisions. */
export function getRecentTrades(n: number): TradeRecord[] {
  const rows = getDb()
    .prepare(`SELECT * FROM trades WHERE paper_mode = ? ORDER BY id DESC LIMIT ?`)
    .all(config.paperMode ? 1 : 0, n) as TradeRow[];
  return rows.reverse().map(fromRow);
}

export function updateTradePnl(id: number, pnl: number, pnlPct: number): void {
  getDb().prepare(`UPDATE trades SET pnl = ?, pnl_pct = ? WHERE id = ?`).run(pnl, pnlPct, id);
}

const COMPLETED = `quantity > 0 AND action != 'exit' AND pnl IS NOT NULL AND paper_mode = ?`;

/** Number of completed (closed) trades in the current mode. Drives the evaluator cadence. */
export function getTotalTradeCount(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM trades WHERE ${COMPLETED}`)
    .get(config.paperMode ? 1 : 0) as { c: number };
  return row.c;
}

/** The last `count` completed trades, oldest first. */
export function getTradesForEvaluation(count: number): TradeRecord[] {
  const rows = getDb()
    .prepare(`SELECT * FROM trades WHERE ${COMPLETED} ORDER BY id DESC LIMIT ?`)
    .all(config.paperMode ? 1 : 0, count) as TradeRow[];
  return rows.reverse().map(fromRow);
}

export function logPortfolioSnapshot(p: PortfolioState): void {
  getDb()
    .prepare(
      `INSERT INTO portfolio_snapshots (timestamp, total_value, total_pnl, total_pnl_pct, trade_count, win_rate)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(new Date().toISOString(), p.totalValue, p.totalPnl, p.totalPnlPct, p.tradeCount, p.winRate);
}

export function getKv(key: string): string | undefined {
  const row = getDb().prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

export function setKv(key: string, value: string): void {
  getDb().prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}
