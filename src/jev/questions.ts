import type { JevQuestion } from './client.js';

export function buildRegimeQuestions(): Record<string, JevQuestion> {
  return {
    regime: {
      type: 'choice',
      instructions:
        'What is the current market regime? Consider recent price action, volatility, and trend strength.',
      criteria: {
        trending_bullish: 'Sustained uptrend with positive momentum and breadth',
        trending_bearish: 'Sustained downtrend with negative momentum and deteriorating breadth',
        ranging: 'Sideways, mean-reverting price action with no clear directional bias',
        volatile: 'Elevated volatility, erratic moves, no reliable trend or range',
        unknown: 'Insufficient clarity to classify — conditions are ambiguous',
      },
    },
    isCoherent: {
      type: 'boolean',
      instructions:
        'Is current volatility and momentum coherent enough to act on signals? True if conditions are clear and orderly, false if noise dominates.',
    },
  };
}
