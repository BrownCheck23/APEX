import type { JevAnswer, JevQuestion } from './client.js';

type State = Record<string, unknown>;
const n = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function softmax(logits: Record<string, number>): Record<string, number> {
  const max = Math.max(...Object.values(logits));
  const exps = Object.fromEntries(Object.entries(logits).map(([k, v]) => [k, Math.exp(v - max)]));
  const sum = Object.values(exps).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(exps).map(([k, v]) => [k, v / sum]));
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function regimeLogits(s: State, options: string[]): Record<string, number> {
  const momentum = n(s.momentum12m);
  const rsi = n(s.rsi14, 50);
  const priceAboveSma = n(s.price) > n(s.sma200) ? 1 : -1;

  const logits: Record<string, number> = {
    trending_bullish: momentum > 0 ? momentum * 8 + priceAboveSma * 1.5 : -2,
    trending_bearish: momentum < 0 ? -momentum * 8 - priceAboveSma * 1.5 : -2,
    ranging: Math.abs(rsi - 50) < 10 ? 1.5 : -0.5,
    volatile: Math.abs(rsi - 50) > 20 ? 1.2 : -1.5,
    unknown: -1.5,
  };
  return Object.fromEntries(options.map((o) => [o, logits[o] ?? -2]));
}

export function offlineJev(state: State, questions: Record<string, JevQuestion>): Record<string, JevAnswer> {
  const out: Record<string, JevAnswer> = {};

  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'choice') {
      const options = Object.keys(q.criteria);
      const logits = regimeLogits(state, options);
      const probabilities = softmax(logits);
      const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
      out[id] = { type: 'choice', choice, probabilities };
    } else if (q.type === 'boolean') {
      const momentum = n(state.momentum12m);
      const rsi = n(state.rsi14, 50);
      const signal = Math.abs(momentum) * 5 + (1 - Math.abs(rsi - 50) / 50) * 2 - 1;
      out[id] = { type: 'boolean', probability: sigmoid(signal) };
    } else if (q.type === 'score') {
      const levels = q.criteria.length;
      out[id] = { type: 'score', score: Math.min(1, Math.max(0, 0.3)) * (levels - 1) };
    }
  }
  return out;
}
