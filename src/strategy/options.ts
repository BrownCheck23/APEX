// disabled pending strategy validation

import type { PortfolioState, StrategyConfig } from '../types.js';

export async function runOptionsCycle(
  _symbols: string[],
  _strategyConfig: StrategyConfig,
  _portfolioState: PortfolioState,
): Promise<void> {
  return;
}

export async function runOptionsExitsOnly(_strategyConfig: StrategyConfig): Promise<void> {
  return;
}

export function exitReason(_position: unknown, _config: StrategyConfig): string | null {
  return null;
}

export async function executeOptionsExit(_position: unknown, _reason: string): Promise<void> {
  return;
}

export async function executeOptionsTrade(): Promise<void> {
  return;
}
