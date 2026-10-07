import type { MarketRegime, StrategyConfig } from '../types.js';

export function classifyRegime(
  signals: { ofi: number; spreadPct: number; volumeVsAvg: number; vwapDeviationPct: number },
  thresholds: StrategyConfig['regimeThresholds'],
): MarketRegime {
  // ILLIQUID: volume vs avg below threshold — no edge, skip
  if (signals.volumeVsAvg < thresholds.volumeIlliquidMax) return 'illiquid';

  // VOLATILE: spread is blowing out — cost of trading too high
  if (signals.spreadPct > thresholds.spreadVolatileMin) return 'volatile';

  // TRENDING: OFI has sustained directional bias
  if (Math.abs(signals.ofi) > thresholds.ofiTrendMin) return 'trending';

  // RANGING: low OFI, tight spread, price near VWAP
  return 'ranging';
}
