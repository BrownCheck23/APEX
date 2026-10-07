// disabled pending strategy validation

import type { PortfolioState, StrategyConfig } from '../types.js';

export async function runCryptoCycle(
  _symbols: string[],
  _strategyConfig: StrategyConfig,
  _portfolioState: PortfolioState,
): Promise<void> {
  return;
}
