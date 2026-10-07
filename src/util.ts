/** Whole calendar days from today (UTC date) until `date` (YYYY-MM-DD or ISO). Negative if in the past. */
export function daysUntil(date: string, now: Date = new Date()): number {
  const target = Date.parse(date.length === 10 ? `${date}T00:00:00Z` : date);
  if (!Number.isFinite(target)) throw new Error(`Invalid date: ${date}`);
  const t = new Date(target);
  const a = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  const b = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((a - b) / 86_400_000);
}

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
