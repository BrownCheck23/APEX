// Runs N bot cycles in-process against the offline simulator (no external API calls) and summarises the result.
// Usage: APEX_OFFLINE_SIM=true APEX_FORCE_MARKET_OPEN=true APEX_DB_PATH=data/sim-verify.db npx tsx scripts/simulate.ts 60
import { config } from '../src/config/index.js';
import { cryptoCycle, equityCycle } from '../src/bot.js';
import { getStrategyConfig } from '../src/config/strategy.js';
import { getDb, initializeDatabase } from '../src/learning/logger.js';
import { getPortfolioState, initializePaperPortfolio } from '../src/portfolio/tracker.js';
import { killSwitch } from '../src/risk/killswitch.js';

if (!config.paperMode || !config.offlineSim) throw new Error('simulate.ts requires PAPER_TRADING=true and APEX_OFFLINE_SIM=true');

const cycles = Number(process.argv[2] ?? 30);
initializeDatabase();
initializePaperPortfolio(config.paperStartingCash);

for (let i = 0; i < cycles; i++) {
  await equityCycle();
  await cryptoCycle();
}

const db = getDb();
const p = getPortfolioState();
console.log('\n=== SIMULATION SUMMARY ===');
console.log('cycles:', cycles);
console.log('decisions logged:', (db.prepare('SELECT COUNT(*) c FROM trades').get() as { c: number }).c);
console.log('orders executed (qty>0):', (db.prepare('SELECT COUNT(*) c FROM trades WHERE quantity > 0').get() as { c: number }).c);
console.log('by asset/action:', db.prepare("SELECT asset_class, action, quantity>0 AS executed, COUNT(*) n FROM trades GROUP BY 1,2,3 ORDER BY 1,2,3").all());
console.log('completed trades:', p.tradeCount, 'wins:', p.winCount);
console.log('portfolio: value', p.totalValue.toFixed(2), 'P&L', p.totalPnl.toFixed(2), `(${(p.totalPnlPct * 100).toFixed(3)}%)`, 'cash', p.cash.toFixed(2));
console.log('open positions:', p.openPositions.map((x) => `${x.symbol} ${x.side} ${x.quantity}`));
console.log('strategy version:', getStrategyConfig().version);
console.log('kill switch:', killSwitch.getState());
console.log('top skip reasons:');
const reasons = new Map<string, number>();
for (const r of db.prepare("SELECT state_snapshot FROM trades WHERE quantity = 0").all() as Array<{ state_snapshot: string }>) {
  const reason = String((JSON.parse(r.state_snapshot) as { reason?: string }).reason ?? '?').replace(/[-\d.]+/g, '#').slice(0, 70);
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
}
for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${String(n).padStart(4)}  ${r}`);
killSwitch.dispose();
process.exit(0);
