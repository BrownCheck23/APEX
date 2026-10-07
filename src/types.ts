// ─── Market Data ────────────────────────────────────────────────────────────

export type MarketRegime =
  | 'trending_bullish' | 'trending_bearish' | 'ranging' | 'volatile' | 'unknown'
  // Legacy values still in the database / regime classifier:
  | 'trending' | 'illiquid';

export interface Quote {
  symbol: string;
  price: number;
  bidPrice: number;
  askPrice: number;
  spread: number;
  spreadPct: number;
  volume: number;
  timestamp: string;
}

export interface L2Snapshot {
  symbol: string;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  bidDepth: number;   // total size at top 5 bid levels
  askDepth: number;   // total size at top 5 ask levels
  ofi: number;        // order flow imbalance: (bidDepth - askDepth) / (bidDepth + askDepth)
}

export interface TechnicalIndicators {
  symbol: string;
  rsi14: number;
  macdLine: number;
  macdSignal: number;
  macdHistogram: number;
  prevMacdHistogram?: number;
  ema20: number;
  sma50: number;
  vwap: number;
  vwapDeviationPct: number;
  bollingerUpper: number;
  bollingerLower: number;
  bollingerPosition: number;
  atr14: number;
  volumeVsAvg: number;
}

export interface OptionsGreeks {
  delta: number;
  theta: number;
  gamma: number;
  vega: number;
  impliedVolatility: number;
  ivRank: number;
  dte: number;
}

// ─── Daily Signal (deterministic entry conditions) ──────────────────────────

export interface DailySignal {
  symbol: string;
  momentum12m: number;      // (last / 252-bars-ago) - 1
  price: number;
  sma200: number;
  rsi14: number;
  entryAllowed: boolean;     // all three deterministic conditions pass
  regime: string;            // Jev regime label
  isCoherent: boolean;       // Jev coherence flag
}

// ─── Jev Filter (classifier, not decision maker) ────────────────────────────

export interface JevFilter {
  regime: string;
  isCoherent: boolean;
  confidence: number;
}

// ─── Trades and Portfolio ─────────────────────────────────────────────────────

export type AssetClass = 'equity' | 'option' | 'crypto';

export interface TradeRecord {
  id?: number;
  timestamp: string;
  symbol: string;
  assetClass: AssetClass;
  regime: string;
  action: string;
  quantity: number;
  price: number;
  notionalValue: number;
  pnl: number | null;
  pnlPct: number | null;
  confidence: number;
  shouldTradeScore: number;
  riskScore: number;
  stateSnapshot: string;
  paperMode: boolean;
  orderId: string | null;
}

export interface Position {
  symbol: string;
  assetClass: AssetClass;
  side: 'long' | 'short';
  quantity: number;
  entryPrice: number;
  entryTimestamp: string;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  greeks?: OptionsGreeks;
  earningsDate?: string;
  underlying?: string;
  tradeId?: number;
}

export interface PortfolioState {
  totalValue: number;
  startingValue: number;
  totalPnl: number;
  totalPnlPct: number;
  todayPnl: number;
  openPositions: Position[];
  cash: number;
  tradeCount: number;
  winCount: number;
  winRate: number;
}

// ─── Strategy Config (evolves via self-improvement) ───────────────────────────

export interface StrategyConfig {
  version: number;
  updatedAt: string;
  confidenceThreshold: number;
  minCoherenceScore: number;         // Jev coherence probability must exceed this
  positionSizingFactor: number;
  rsiLowerBound: number;             // RSI must be above this for entry (default 35)
  rsiUpperBound: number;             // RSI must be below this for entry (default 65)
  // Legacy fields kept for backwards compat with stored configs:
  maxRiskScore?: number;
  regimeThresholds: {
    ofiTrendMin: number;
    vwapDeviationRangingMax: number;
    spreadVolatileMin: number;
    volumeIlliquidMax: number;
  };
  optionsConfig: {
    maxIvRank: number;
    minDte: number;
    maxDte: number;
    targetDelta: number;
    exitPnlPct: number;
    stopLossPnlPct: number;
  };
}

// ─── Kill Switch ─────────────────────────────────────────────────────────────

export type KillSwitchLevel = 'none' | 'confidence' | 'soft' | 'hard';

export interface KillSwitchState {
  level: KillSwitchLevel;
  triggered: boolean;
  reason: string | null;
  triggeredAt: string | null;
  canResume: boolean;
}

// ─── Execution plumbing ─────────────────────────────────────────────────────

export interface EquityOrderParams {
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  type: 'market' | 'limit';
  limitPrice?: number;
  quote?: Pick<Quote, 'price' | 'bidPrice' | 'askPrice'>;
}

export interface OptionOrderParams {
  symbol: string;
  optionSymbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  type: 'market' | 'limit';
  limitPrice?: number;
  quote?: Pick<Quote, 'price' | 'bidPrice' | 'askPrice'>;
}

export interface CryptoOrderParams {
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  type: 'market' | 'limit';
  limitPrice?: number;
  quote?: Pick<Quote, 'price' | 'bidPrice' | 'askPrice'>;
}

export interface OrderResult {
  orderId: string;
  filledPrice: number;
}

export interface ExecutionEngine {
  placeEquityOrder(params: EquityOrderParams): Promise<OrderResult>;
  placeOptionOrder(params: OptionOrderParams): Promise<OrderResult>;
  placeCryptoOrder(params: CryptoOrderParams): Promise<OrderResult>;
}

export type StrategyUpdate = Partial<StrategyConfig> & { reasoning?: string };
