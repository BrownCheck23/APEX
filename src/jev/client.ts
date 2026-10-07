import { createTypeSafeAi } from '@ai-sdk/typesafe-ai';
import { experimental_decide } from 'ai';
import { config } from '../config/index.js';
import type { JevFilter } from '../types.js';
import { offlineJev } from './offline.js';

const JEV_MODEL = process.env.JEV_MODEL?.trim() || 'jev-latest';
const TIMEOUT_MS = 30_000;

type DecisionState = Parameters<typeof experimental_decide>[0]['state'];

export type JevQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'boolean'; instructions: string; criteria?: { true?: string | null; false?: string | null } };

export type JevAnswer =
  | { type: 'choice'; choice: string; probabilities?: Record<string, number> }
  | { type: 'score'; score: number; probabilities?: Record<string, number> }
  | { type: 'boolean'; probability: number };

let provider: ReturnType<typeof createTypeSafeAi> | null = null;

export async function askJev(params: {
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
}): Promise<Record<string, JevAnswer>> {
  if (config.offlineSim) return offlineJev(params.state, params.questions);

  provider ??= createTypeSafeAi({ apiKey: config.jevApiKey });
  const result = await experimental_decide({
    model: provider.decisionModel(JEV_MODEL),
    state: params.state as DecisionState,
    questions: params.questions,
    abortSignal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return result.answers as Record<string, JevAnswer>;
}

export async function classifyRegime(
  state: Record<string, unknown>,
  questions: Record<string, JevQuestion>,
): Promise<JevFilter> {
  const answers = await askJev({ state, questions });

  const regimeAnswer = answers.regime;
  const regime = regimeAnswer?.type === 'choice' ? regimeAnswer.choice : 'unknown';
  const confidence = regimeAnswer?.type === 'choice' ? (regimeAnswer.probabilities?.[regime] ?? 0) : 0;

  const coherenceAnswer = answers.isCoherent;
  const coherenceProbability = coherenceAnswer?.type === 'boolean' ? coherenceAnswer.probability : 0;

  return {
    regime,
    isCoherent: coherenceProbability >= 0.5,
    confidence,
  };
}
