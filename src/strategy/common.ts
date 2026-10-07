import { getRecentTrades, logTrade } from '../learning/logger.js';
import { closePosition, getPosition, openPosition, type OpenExtras } from '../portfolio/tracker.js';
import { logger } from '../logging.js';
import type {
  AssetClass, JevFilter, PortfolioState, StrategyConfig, TradeRecord,
} from '../types.js';
import { config } from '../config/index.js';

export const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export function gateReason(filter: JevFilter, cfg: StrategyConfig): string | null {
  if (filter.confidence < cfg.confidenceThreshold) {
    return `confidence ${filter.confidence.toFixed(3)} < threshold ${cfg.confidenceThreshold}`;
  }
  if (!filter.isCoherent) {
    return 'Jev flagged conditions as incoherent';
  }
  if (filter.regime === 'volatile') {
    return `regime is volatile — no entries`;
  }
  return null;
}

export function positionQuantity(
  price: number,
  portfolio: PortfolioState,
  cfg: StrategyConfig,
  opts: { maxPct?: number; multiplier?: number; decimals?: number } = {},
): number {
  const mult = opts.multiplier ?? 1;
  const factor = 10 ** (opts.decimals ?? 0);
  const maxPct = opts.maxPct ?? config.maxPositionSizePct;
  const budget = Math.min(portfolio.totalValue * maxPct * cfg.positionSizingFactor, portfolio.cash);
  if (!(price > 0) || !(budget > 0)) return 0;
  return Math.floor((budget / (price * mult)) * factor) / factor;
}

export interface DecisionLog {
  symbol: string;
  assetClass: AssetClass;
  regime: string;
  action: string;
  price: number;
  filter?: { confidence: number; isCoherent: boolean; regime: string };
  state: unknown;
  reason: string;
  extra?: Record<string, unknown>;
}

export function logDecision(d: DecisionLog): number {
  const rec: TradeRecord = {
    timestamp: new Date().toISOString(),
    symbol: d.symbol,
    assetClass: d.assetClass,
    regime: d.regime,
    action: d.action,
    quantity: 0,
    price: d.price,
    notionalValue: 0,
    pnl: null,
    pnlPct: null,
    confidence: d.filter?.confidence ?? 0,
    shouldTradeScore: d.filter?.isCoherent ? 1 : 0,
    riskScore: 0,
    stateSnapshot: JSON.stringify({ state: d.state, filter: d.filter, reason: d.reason, ...d.extra }),
    paperMode: config.paperMode,
    orderId: null,
  };
  logger.info(`${d.symbol} [${d.assetClass}/${d.regime}] ${d.action} — ${d.reason}`);
  return logTrade(rec);
}

export interface ExecutedLog extends Omit<DecisionLog, 'reason'> {
  quantity: number;
  fillPrice: number;
  orderId: string;
  pnl?: { value: number; pct: number };
  reason: string;
  multiplier?: number;
}

export function logExecution(d: ExecutedLog): number {
  const rec: TradeRecord = {
    timestamp: new Date().toISOString(),
    symbol: d.symbol,
    assetClass: d.assetClass,
    regime: d.regime,
    action: d.action,
    quantity: d.quantity,
    price: d.fillPrice,
    notionalValue: d.fillPrice * d.quantity * (d.multiplier ?? 1),
    pnl: d.pnl?.value ?? null,
    pnlPct: d.pnl?.pct ?? null,
    confidence: d.filter?.confidence ?? 0,
    shouldTradeScore: d.filter?.isCoherent ? 1 : 0,
    riskScore: 0,
    stateSnapshot: JSON.stringify({ state: d.state, filter: d.filter, reason: d.reason, ...d.extra }),
    paperMode: config.paperMode,
    orderId: d.orderId,
  };
  logger.info(`${d.symbol} [${d.assetClass}] ${d.action} ${d.quantity} @ ${d.fillPrice.toFixed(4)} — ${d.reason}`);
  return logTrade(rec);
}

export function recentTrades(): TradeRecord[] {
  return getRecentTrades(100);
}

export function openTrackedPosition(d: ExecutedLog, rowId: number, extras: OpenExtras = {}): void {
  openPosition(
    {
      id: rowId,
      timestamp: new Date().toISOString(),
      symbol: d.symbol,
      assetClass: d.assetClass,
      regime: d.regime,
      action: d.action,
      quantity: d.quantity,
      price: d.fillPrice,
      notionalValue: d.fillPrice * d.quantity * (d.multiplier ?? 1),
      pnl: null,
      pnlPct: null,
      confidence: d.filter?.confidence ?? 0,
      shouldTradeScore: d.filter?.isCoherent ? 1 : 0,
      riskScore: 0,
      stateSnapshot: '',
      paperMode: config.paperMode,
      orderId: d.orderId,
    },
    extras,
  );
}

export function closeTrackedPosition(d: Omit<ExecutedLog, 'action' | 'quantity'>): number {
  const pos = getPosition(d.symbol);
  if (!pos) throw new Error(`No open position in ${d.symbol} to close`);
  const mult = d.multiplier ?? 1;
  const basis = pos.entryPrice * pos.quantity * mult;
  const pnl = closePosition(d.symbol, d.fillPrice);
  logExecution({
    ...d,
    action: 'exit',
    quantity: pos.quantity,
    pnl: { value: pnl, pct: basis > 0 ? (pnl / basis) * 100 : 0 },
  });
  return pnl;
}
