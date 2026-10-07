import { config } from '../config/index.js';
import { isRecord, parseJson, toNumOrNull } from '../data/parse.js';
import {
  placeCryptoOrder, placeOptionOrder, placeOrder, reviewOptionOrder, reviewOrder,
} from '../data/robinhood.js';
import { logger } from '../logging.js';
import { getPortfolioState } from '../portfolio/tracker.js';
import type {
  CryptoOrderParams, EquityOrderParams, ExecutionEngine, OptionOrderParams, OrderResult,
} from '../types.js';

/**
 * Live execution through the Robinhood MCP (via Claude API calls). Every function refuses to run in
 * paper mode, and every equity/option order is reviewed first (rule 2): any alert that is not purely
 * informational skips the trade.
 */

/** Thrown when the review step blocks an order. Callers log the decision as a skipped trade. */
export class OrderSkipped extends Error {
  constructor(message: string, readonly alerts: string[]) {
    super(message);
    this.name = 'OrderSkipped';
  }
}

function assertLive(label: string): void {
  if (config.paperMode) throw new Error(`${label}: live execution invoked in paper mode`);
}

function review(raw: string, label: string): number | null {
  const r = parseJson<unknown>(raw);
  if (!isRecord(r)) throw new OrderSkipped(`${label}: unreadable review response`, []);
  const alerts = (Array.isArray(r.alerts) ? r.alerts : []).filter(isRecord);
  const blocking: string[] = [];
  for (const a of alerts) {
    const msg = String(a.message ?? 'alert');
    const severity = String(a.severity ?? 'warning').toLowerCase();
    logger.warn(`${label}: review alert [${severity}] ${msg}`);
    if (severity !== 'info' && severity !== 'informational') blocking.push(msg);
  }
  if (r.ok === false && blocking.length === 0) blocking.push('review reported ok=false');
  if (blocking.length > 0) throw new OrderSkipped(`${label}: review blocked the order`, blocking);
  return toNumOrNull(r.estimatedPrice);
}

function parsePlaced(raw: string, fallbackPrice: number, label: string): OrderResult {
  const r = parseJson<unknown>(raw);
  if (!isRecord(r) || !r.orderId) throw new Error(`${label}: no orderId in placement response`);
  const filled = toNumOrNull(r.filledPrice);
  return { orderId: String(r.orderId), filledPrice: filled && filled > 0 ? filled : fallbackPrice };
}

export class LiveExecutionEngine implements ExecutionEngine {
  async placeEquityOrder(p: EquityOrderParams): Promise<OrderResult> {
    const label = `live equity ${p.side} ${p.symbol}`;
    assertLive(label);
    const order = {
      accountNumber: config.accountNumber,
      symbol: p.symbol,
      side: p.side,
      quantity: String(p.quantity),
      type: p.type,
      ...(p.limitPrice !== undefined ? { limitPrice: String(p.limitPrice) } : {}),
    };
    const est = review(await reviewOrder(order), label);          // review_equity_order first, always
    return parsePlaced(await placeOrder(order), est ?? p.quote?.price ?? 0, label);
  }

  async placeOptionOrder(p: OptionOrderParams): Promise<OrderResult> {
    const label = `live option ${p.side} ${p.optionSymbol}`;
    assertLive(label);
    const order = {
      accountNumber: config.accountNumber,
      optionSymbol: p.optionSymbol,
      side: p.side,
      quantity: String(p.quantity),
      type: p.type,
      ...(p.limitPrice !== undefined ? { limitPrice: String(p.limitPrice) } : {}),
    };
    const est = review(await reviewOptionOrder(order), label);    // review_option_order first, always
    return parsePlaced(await placeOptionOrder(order), est ?? p.quote?.price ?? 0, label);
  }

  async placeCryptoOrder(p: CryptoOrderParams): Promise<OrderResult> {
    const label = `live crypto ${p.side} ${p.symbol}`;
    assertLive(label);
    // The MCP has no crypto review tool, so apply the position-size limit here instead.
    const price = p.quote?.price ?? p.limitPrice ?? 0;
    const cap = getPortfolioState().totalValue * config.maxPositionSizePct;
    if (p.side === 'buy' && price * p.quantity > cap * 1.01) {
      throw new OrderSkipped(`${label}: notional exceeds the ${(config.maxPositionSizePct * 100).toFixed(0)}% position cap`, []);
    }
    const order = {
      accountNumber: config.rhsAccountNumber,
      symbol: p.symbol,
      side: p.side,
      quantity: String(p.quantity),
      type: p.type,
      ...(p.limitPrice !== undefined ? { limitPrice: String(p.limitPrice) } : {}),
    };
    return parsePlaced(await placeCryptoOrder(order), price, label);
  }
}
