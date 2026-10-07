import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '..', '..');

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

function str(name: string, fallback?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  return '';
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got "${raw}"`);
  return n;
}

function frac(name: string, fallback: number): number {
  const n = num(name, fallback);
  if (n <= 0 || n >= 1) throw new Error(`Env var ${name} must be between 0 and 1 (exclusive), got ${n}`);
  return n;
}

/** On unless explicitly set to "false". */
function flag(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() !== 'false';
}

function posInt(name: string, fallback: number): number {
  const n = num(name, fallback);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Env var ${name} must be a positive integer, got ${n}`);
  return n;
}

// Safety: paper mode is the default. Only the literal string "false" enables live trading,
// so a typo or empty value can never flip the bot to real money.
const paperMode = process.env.PAPER_TRADING?.trim().toLowerCase() !== 'false';
const offlineSim = process.env.APEX_OFFLINE_SIM?.trim().toLowerCase() === 'true';

if (offlineSim && !paperMode) {
  throw new Error('APEX_OFFLINE_SIM=true is only allowed with PAPER_TRADING=true');
}

const missing: string[] = [];
const anthropicApiKey = str('ANTHROPIC_API_KEY');
const jevApiKey = str('TYPESAFE_AI_API_KEY') || str('VERCEL_AI_GATEWAY_TOKEN');
const accountNumber = str('ROBINHOOD_ACCOUNT_NUMBER');
const rhsAccountNumber = str('ROBINHOOD_RHS_ACCOUNT_NUMBER');

if (!offlineSim) {
  if (!anthropicApiKey) missing.push('ANTHROPIC_API_KEY');
  if (!jevApiKey) missing.push('TYPESAFE_AI_API_KEY (or VERCEL_AI_GATEWAY_TOKEN)');
  if (!paperMode) {
    if (!accountNumber) missing.push('ROBINHOOD_ACCOUNT_NUMBER');
    if (!rhsAccountNumber) missing.push('ROBINHOOD_RHS_ACCOUNT_NUMBER');
  }
}
if (missing.length > 0) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}. See .env.example.`);
}

const hardStopPct = frac('HARD_STOP_PCT', 0.10);
const softStopPct = frac('SOFT_STOP_PCT', 0.05);
if (softStopPct >= hardStopPct) {
  throw new Error('SOFT_STOP_PCT must be smaller than HARD_STOP_PCT');
}

export const config = {
  paperMode,
  offlineSim,
  anthropicApiKey,
  jevApiKey,
  accountNumber,
  rhsAccountNumber,
  confidenceThreshold: frac('CONFIDENCE_THRESHOLD', 0.65),
  hardStopPct,
  softStopPct,
  evaluationTradeCount: posInt('EVALUATION_TRADE_COUNT', 50),
  maxPositionSizePct: frac('MAX_POSITION_SIZE_PCT', 0.05),
  equityCycleMinutes: posInt('EQUITY_CYCLE_MINUTES', 15),
  cryptoCycleMinutes: posInt('CRYPTO_CYCLE_MINUTES', 30),
  scanId: str('MOMENTUM_SCANNER_ID', '7c777075'),
  dashboardPort: posInt('DASHBOARD_PORT', 3001),
  enableOptions: flag('APEX_ENABLE_OPTIONS'),
  enableCrypto: flag('APEX_ENABLE_CRYPTO'),
  watchlistSize: Math.min(4, posInt('WATCHLIST_SIZE', 2)), // 4 is the L2 book limit
  dbPath: process.env.APEX_DB_PATH?.trim() || path.join(PROJECT_ROOT, 'data', 'apex.db'),
  logDir: path.join(PROJECT_ROOT, 'logs'),
  paperStartingCash: 100000,
  cryptoSymbols: ['BTC', 'ETH'] as string[],
} as const;

/** Strip any configured secret from a string before it is logged or sent to the dashboard. */
export function redact(text: string): string {
  let out = text;
  for (const secret of [anthropicApiKey, jevApiKey]) {
    if (secret && secret.length >= 6) out = out.split(secret).join('[REDACTED]');
  }
  return out.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]');
}
