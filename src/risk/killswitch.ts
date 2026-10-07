import { config } from '../config/index.js';
import { runEvaluationIfNeeded } from '../learning/evaluator.js';
import { getRecentTrades } from '../learning/logger.js';
import { logger } from '../logging.js';
import { getPortfolioState } from '../portfolio/tracker.js';
import type { KillSwitchLevel, KillSwitchState, PortfolioState, TradeRecord } from '../types.js';

const CONFIDENCE_WINDOW = 20;
const CONFIDENCE_FLOOR = 0.52;
const CONFIDENCE_COOLDOWN_MS = 60 * 60 * 1000;

const CLEAR: KillSwitchState = { level: 'none', triggered: false, reason: null, triggeredAt: null, canResume: false };

function flushAndExit(code: number): void {
  // Give winston a chance to write the final lines before the process dies.
  const t = setTimeout(() => process.exit(code), 2000);
  logger.on('finish', () => { clearTimeout(t); process.exit(code); });
  logger.end();
}

export class KillSwitch {
  private state: KillSwitchState = { ...CLEAR };
  /** Decisions logged before this row id are ignored by the confidence stop (they led to the last trigger). */
  private confidenceFloorId = 0;
  private confidenceTimer: NodeJS.Timeout | null = null;

  constructor(private readonly onHardStop: () => void = () => flushAndExit(1)) {}

  check(portfolio: PortfolioState, recentTrades: TradeRecord[]): KillSwitchState {
    const totalPnlPct = portfolio.totalPnlPct;

    // HARD STOP — bot terminates entirely
    if (totalPnlPct < -config.hardStopPct) {
      this.trigger('hard', `Hard stop: ${(totalPnlPct * 100).toFixed(2)}% total loss. Bot terminated.`, false);
      return this.state;
    }
    if (this.state.triggered) return this.state;

    // SOFT STOP — pause and run evaluation
    if (totalPnlPct < -config.softStopPct) {
      this.trigger('soft', `Soft stop: ${(totalPnlPct * 100).toFixed(2)}% loss. Pausing for evaluation.`, true);
      runEvaluationIfNeeded()
        .catch((err) => logger.error(`Evaluation during soft stop failed: ${(err as Error).message}`))
        .finally(() => this.resume());
      return this.state;
    }

    // CONFIDENCE STOP — Jev is near-random, market unreadable
    const window = recentTrades.filter((t) => (t.id ?? 0) > this.confidenceFloorId && t.confidence > 0).slice(-CONFIDENCE_WINDOW);
    if (window.length >= CONFIDENCE_WINDOW && this.calcAvgConfidence(window, CONFIDENCE_WINDOW) < CONFIDENCE_FLOOR) {
      this.trigger('confidence', 'Confidence stop: Jev average confidence near random. Market unreadable.', true);
      // Nothing is decided while paused, so the window would never refresh. Cool down, then start a fresh window.
      this.confidenceFloorId = Math.max(0, ...recentTrades.map((t) => t.id ?? 0));
      this.confidenceTimer = setTimeout(() => this.resume(), CONFIDENCE_COOLDOWN_MS);
      this.confidenceTimer.unref();
    }

    return this.state;
  }

  isActive(): boolean {
    return this.state.triggered;
  }

  getState(): KillSwitchState {
    return { ...this.state };
  }

  /** Test/ops helper: clear the confidence cooldown timer. */
  dispose(): void {
    if (this.confidenceTimer) clearTimeout(this.confidenceTimer);
  }

  private calcAvgConfidence(trades: TradeRecord[], n: number): number {
    const slice = trades.filter((t) => t.confidence > 0).slice(-n);
    if (slice.length === 0) return 1; // nothing to judge yet
    return slice.reduce((a, t) => a + t.confidence, 0) / slice.length;
  }

  private trigger(level: KillSwitchLevel, reason: string, canResume: boolean): void {
    if (this.state.level === level && this.state.triggered) return;
    this.state = { level, triggered: true, reason, triggeredAt: new Date().toISOString(), canResume };
    logger.warn(`KILL SWITCH [${level.toUpperCase()}]: ${reason}`);

    if (level === 'hard') {
      logger.error('Hard stop triggered. Shutting down. Open positions are NOT closed automatically.');
      this.onHardStop();
    }
  }

  private resume(): void {
    if (this.state.canResume) {
      if (this.confidenceTimer) clearTimeout(this.confidenceTimer);
      this.confidenceTimer = null;
      this.state = { ...CLEAR };
      logger.info('Kill switch cleared. Resuming trading.');
    }
  }
}

export const killSwitch = new KillSwitch();

/**
 * Rule 3: runs before every trade decision. Returns false when trading must stop, and the caller
 * must stop its loop. There is no override.
 */
export function canTrade(): boolean {
  if (killSwitch.isActive()) return false;
  killSwitch.check(getPortfolioState(), getRecentTrades(50));
  return !killSwitch.isActive();
}
