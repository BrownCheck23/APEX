import { getDb } from '../learning/logger.js';
import type { StrategyConfig } from '../types.js';
import { config } from './index.js';

export function defaultStrategy(): StrategyConfig {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    confidenceThreshold: config.confidenceThreshold,
    minCoherenceScore: 0.55,
    positionSizingFactor: 1.0,
    rsiLowerBound: 35,
    rsiUpperBound: 65,
    regimeThresholds: {
      ofiTrendMin: 0.25,
      vwapDeviationRangingMax: 0.5,
      spreadVolatileMin: 0.3,
      volumeIlliquidMax: 0.4,
    },
    optionsConfig: {
      maxIvRank: 50,
      minDte: 21,
      maxDte: 60,
      targetDelta: 0.40,
      exitPnlPct: 50,
      stopLossPnlPct: -35,
    },
  };
}

function withDefaults(stored: Partial<StrategyConfig>): StrategyConfig {
  const d = defaultStrategy();
  // Rows saved by older versions may carry featureWeights or minShouldTradeScore; migrate.
  const { featureWeights: _dropped, minShouldTradeScore, ...rest } = stored as Partial<StrategyConfig> & { featureWeights?: unknown; minShouldTradeScore?: number };
  const merged = {
    ...d,
    ...rest,
    regimeThresholds: { ...d.regimeThresholds, ...stored.regimeThresholds },
    optionsConfig: { ...d.optionsConfig, ...stored.optionsConfig },
  };
  if (typeof minShouldTradeScore === 'number' && merged.minCoherenceScore === d.minCoherenceScore) {
    merged.minCoherenceScore = minShouldTradeScore;
  }
  return merged;
}

export function getStrategyConfig(): StrategyConfig {
  const row = getDb()
    .prepare(`SELECT config_json FROM strategy_config ORDER BY id DESC LIMIT 1`)
    .get() as { config_json: string } | undefined;

  if (!row) {
    const seed = defaultStrategy();
    saveStrategyConfig(seed);
    return seed;
  }
  return withDefaults(JSON.parse(row.config_json) as Partial<StrategyConfig>);
}

export function saveStrategyConfig(cfg: StrategyConfig): void {
  getDb()
    .prepare(`INSERT INTO strategy_config (version, updated_at, config_json) VALUES (?, ?, ?)`)
    .run(cfg.version, cfg.updatedAt, JSON.stringify(cfg));
}
