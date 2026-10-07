import { config } from '../config/index.js';
import type { ExecutionEngine } from '../types.js';
import { LiveExecutionEngine } from './live.js';
import { PaperExecutionEngine } from './paper.js';

let engine: ExecutionEngine | null = null;

/** The one place that switches on config.paperMode. */
export function getExecutionEngine(): ExecutionEngine {
  engine ??= config.paperMode ? new PaperExecutionEngine() : new LiveExecutionEngine();
  return engine;
}
