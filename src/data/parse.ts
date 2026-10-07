/**
 * Helpers for turning Robinhood/Claude reply strings into typed values. Only market.ts and
 * tracker.ts call these; raw strings never travel further than that (spec: Module 5).
 */

export function parseJson<T = unknown>(raw: string): T {
  const cleaned = raw.replace(/```json|```/gi, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Tolerate leading/trailing chatter: take the outermost {...} or [...]
    const open = cleaned.search(/[{[]/);
    const close = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
    if (open >= 0 && close > open) {
      try {
        return JSON.parse(cleaned.slice(open, close + 1)) as T;
      } catch { /* fall through */ }
    }
    throw new Error(`Could not parse JSON from reply: ${cleaned.slice(0, 160)}`);
  }
}

export function toNum(v: unknown, fallback?: number): number {
  const n = typeof v === 'string' ? Number(v.replace(/[$,%\s]/g, '')) : typeof v === 'number' ? v : NaN;
  if (Number.isFinite(n)) return n;
  if (fallback !== undefined) return fallback;
  throw new Error(`Expected a number, got ${JSON.stringify(v)}`);
}

export function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = toNum(v, NaN);
  return Number.isFinite(n) ? n : null;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
