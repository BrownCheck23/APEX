import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/index.js';
import { getStrategyConfig, saveStrategyConfig } from '../config/strategy.js';
import { logger } from '../logging.js';
import type { StrategyConfig, StrategyUpdate, TradeRecord } from '../types.js';
import { getKv, getTradesForEvaluation, getTotalTradeCount, setKv } from './logger.js';

const MODEL = process.env.APEX_CLAUDE_MODEL?.trim() || 'claude-sonnet-4-6';
const MAX_SHIFT = 0.2;

let anthropic: Anthropic | null = null;

function summarise(t: TradeRecord) {
  let features: Record<string, unknown> = {};
  try {
    const snap = JSON.parse(t.stateSnapshot) as { state?: Record<string, unknown> };
    const s = snap.state ?? {};
    features = {
      momentum12m: s.momentum12m,
      rsi14: s.rsi14,
      sma200: s.sma200,
      price: s.price,
      regime: s.regime,
      isCoherent: s.isCoherent,
    };
  } catch { /* unreadable snapshot: evaluate on outcome alone */ }
  return {
    symbol: t.symbol, assetClass: t.assetClass, regime: t.regime, action: t.action,
    confidence: t.confidence, coherenceScore: t.shouldTradeScore,
    pnl: t.pnl, pnlPct: t.pnlPct, features,
  };
}

export async function runEvaluation(tradeLog: TradeRecord[]): Promise<StrategyUpdate> {
  if (config.offlineSim) return offlineEvaluation(tradeLog);

  anthropic ??= new Anthropic({ apiKey: config.anthropicApiKey });
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `Analyze these ${tradeLog.length} trades from a daily equity strategy (SPY + QQQ only) and return ONLY valid JSON.

Strategy context:
- Entry: 12-month momentum > 0, price > 200-day SMA, RSI-14 in [rsiLowerBound, rsiUpperBound]
- Jev provides regime label and coherence flag; volatile/trending_bearish and incoherence veto entries
- Position sizing capped at 40% per symbol, 80% total
- Exit: 5% trailing stop, price below 200-SMA, or regime deterioration

Trade log:
${JSON.stringify(tradeLog.map(summarise), null, 2)}

Return a JSON object with these fields:
{
  "confidenceThreshold": <number 0.5-0.9>,
  "minCoherenceScore": <number 0.4-0.8>,
  "positionSizingFactor": <number 0.5-1.5>,
  "rsiLowerBound": <integer 20-45>,
  "rsiUpperBound": <integer 55-80>,
  "reasoning": "<one sentence on what changed and why>"
}

Analysis guidelines:
- Which Jev regime labels (trending_bullish, ranging, etc.) correlated with profitable entries?
- Should the RSI band be tighter (fewer but higher-quality entries) or wider (more entries)?
- Was the 200-day SMA filter bypassed and did that hurt?
- Increase confidenceThreshold if low-confidence trades lost money
- Decrease positionSizingFactor if overall P&L is negative
- Lower minCoherenceScore if coherent trades underperformed incoherent ones (rare — usually raise it)
- Max 20% shift per evaluation cycle on all numeric fields`,
    }],
  });

  const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean) as StrategyUpdate;
}

function offlineEvaluation(trades: TradeRecord[]): StrategyUpdate {
  const total = trades.reduce((a, t) => a + (t.pnl ?? 0), 0);
  const cur = getStrategyConfig();
  const losing = total < 0;
  return {
    confidenceThreshold: cur.confidenceThreshold + (losing ? 0.02 : -0.01),
    positionSizingFactor: cur.positionSizingFactor * (losing ? 0.9 : 1.05),
    reasoning: `[offline sim] total P&L ${total.toFixed(2)} over ${trades.length} trades; ${losing ? 'tightening threshold and shrinking size' : 'easing threshold and growing size slightly'}`,
  };
}

const RANGES = {
  confidenceThreshold: [0.5, 0.9] as const,
  minCoherenceScore: [0.4, 0.8] as const,
  positionSizingFactor: [0.5, 1.5] as const,
  rsiLowerBound: [20, 45] as const,
  rsiUpperBound: [55, 80] as const,
};

function bounded(current: number, proposed: unknown, [lo, hi]: readonly [number, number]): number {
  if (typeof proposed !== 'number' || !Number.isFinite(proposed)) return current;
  const shiftLo = current * (1 - MAX_SHIFT);
  const shiftHi = current * (1 + MAX_SHIFT);
  const v = Math.min(Math.max(proposed, shiftLo), shiftHi);
  const out = Math.min(Math.max(v, lo), hi);
  return Number(out.toFixed(4));
}

export function mergeUpdates(current: StrategyConfig, updates: StrategyUpdate): StrategyConfig {
  return {
    ...current,
    confidenceThreshold: bounded(current.confidenceThreshold, updates.confidenceThreshold, RANGES.confidenceThreshold),
    minCoherenceScore: bounded(current.minCoherenceScore, updates.minCoherenceScore, RANGES.minCoherenceScore),
    positionSizingFactor: bounded(current.positionSizingFactor, updates.positionSizingFactor, RANGES.positionSizingFactor),
    rsiLowerBound: bounded(current.rsiLowerBound, updates.rsiLowerBound, RANGES.rsiLowerBound),
    rsiUpperBound: bounded(current.rsiUpperBound, updates.rsiUpperBound, RANGES.rsiUpperBound),
    version: current.version + 1,
    updatedAt: new Date().toISOString(),
  };
}

const kvKey = () => `last_evaluated_trade_count_${config.paperMode ? 'paper' : 'live'}`;

export async function runEvaluationIfNeeded(): Promise<void> {
  const tradeCount = getTotalTradeCount();
  const last = Number(getKv(kvKey()) ?? 0);

  if (tradeCount === 0 || tradeCount % config.evaluationTradeCount !== 0 || tradeCount <= last) return;

  logger.info(`Running self-improvement evaluation at trade ${tradeCount}`);
  setKv(kvKey(), String(tradeCount));

  const recentTrades = getTradesForEvaluation(config.evaluationTradeCount);
  const currentConfig = getStrategyConfig();

  let updates: StrategyUpdate;
  try {
    updates = await runEvaluation(recentTrades);
  } catch (err) {
    logger.error(`Evaluation failed, strategy unchanged: ${(err as Error).message}`);
    return;
  }

  const newConfig = mergeUpdates(currentConfig, updates);
  saveStrategyConfig(newConfig);
  logger.info(`Strategy updated to v${newConfig.version}: ${typeof updates.reasoning === 'string' ? updates.reasoning : '(no reasoning given)'}`);
}
