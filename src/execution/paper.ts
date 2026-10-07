import { getPortfolioState } from '../portfolio/tracker.js';
import type {
  CryptoOrderParams, EquityOrderParams, ExecutionEngine, OptionOrderParams, OrderResult,
} from '../types.js';

/**
 * Paper trading simulator. Fills against the supplied quote and never touches Robinhood: this file
 * does not import any place_* wrapper. Position and cash bookkeeping stays in the portfolio tracker;
 * this engine only decides the fill price.
 *
 * Fill model (spec): market buys fill at the ask and market sells at the bid, each worsened by 0.1%
 * slippage. No partial fills.
 */

const SLIPPAGE = 0.001;
let orderSeq = 0;

type Quoted = { quote?: { price: number; bidPrice: number; askPrice: number } };

function fill(p: { side: 'buy' | 'sell'; quantity: number; type: 'market' | 'limit'; limitPrice?: number } & Quoted, label: string): number {
  if (!(p.quantity > 0)) throw new Error(`${label}: quantity must be positive`);
  if (!p.quote) throw new Error(`${label}: paper fills need a reference quote`);
  const { price, bidPrice, askPrice } = p.quote;
  const ask = askPrice > 0 ? askPrice : price;
  const bid = bidPrice > 0 ? bidPrice : price;

  const market = p.side === 'buy' ? ask * (1 + SLIPPAGE) : bid * (1 - SLIPPAGE);
  if (p.type === 'market') return market;

  if (p.limitPrice === undefined) throw new Error(`${label}: limit order needs a limitPrice`);
  const marketable = p.side === 'buy' ? p.limitPrice >= market : p.limitPrice <= market;
  if (!marketable) throw new Error(`${label}: limit ${p.limitPrice} not marketable against ${market.toFixed(4)} (paper engine does not rest orders)`);
  return market; // fills at the simulated market price, which is at least as good as the limit
}

function assertCash(side: 'buy' | 'sell', notional: number, label: string): void {
  if (side === 'buy' && notional > getPortfolioState().cash) {
    throw new Error(`${label}: insufficient paper cash (${notional.toFixed(2)} needed, ${getPortfolioState().cash.toFixed(2)} available)`);
  }
}

function result(kind: string, filledPrice: number): OrderResult {
  orderSeq += 1;
  return { orderId: `paper-${kind}-${Date.now()}-${orderSeq}`, filledPrice };
}

export class PaperExecutionEngine implements ExecutionEngine {
  async placeEquityOrder(params: EquityOrderParams): Promise<OrderResult> {
    const price = fill(params, `paper equity ${params.symbol}`);
    assertCash(params.side, price * params.quantity, `paper equity ${params.symbol}`);
    return result('eq', price);
  }

  async placeOptionOrder(params: OptionOrderParams): Promise<OrderResult> {
    const price = fill(params, `paper option ${params.optionSymbol}`);
    assertCash(params.side, price * params.quantity * 100, `paper option ${params.optionSymbol}`);
    return result('opt', price);
  }

  async placeCryptoOrder(params: CryptoOrderParams): Promise<OrderResult> {
    const price = fill(params, `paper crypto ${params.symbol}`);
    assertCash(params.side, price * params.quantity, `paper crypto ${params.symbol}`);
    return result('cry', price);
  }
}
