// Lists the tools the Robinhood MCP server really exposes, with their input schemas.
//   npm run robinhood:tools            -> tool names, descriptions, schemas (no account data)
//   npm run robinhood:tools -- --sample -> also calls get_accounts / get_portfolio / get_equity_quotes (SPY)
//                                          and prints the raw replies, so the normalisers in robinhood.ts can be
//                                          checked against real data. The output contains YOUR account data:
//                                          do not paste it anywhere without removing account numbers and balances.
import { callTool, closeRobinhood, listRobinhoodTools } from '../src/data/robinhood.js';

const tools = await listRobinhoodTools();
console.log(`${tools.length} tools:\n`);
for (const t of tools) {
  console.log(`● ${t.name}${t.description ? ` — ${t.description.split('\n')[0]}` : ''}`);
  console.log(JSON.stringify(t.inputSchema, null, 2).split('\n').map((l) => `    ${l}`).join('\n'));
}

if (process.argv.includes('--sample')) {
  for (const [name, args] of [['get_accounts', {}], ['get_portfolio', {}], ['get_equity_quotes', { symbols: ['SPY'] }]] as const) {
    console.log(`\n=== ${name} ${JSON.stringify(args)}`);
    try {
      console.log(JSON.stringify(await callTool(name, args as Record<string, unknown>), null, 2));
    } catch (err) {
      console.log(`failed: ${(err as Error).message}`);
    }
  }
}
await closeRobinhood();
process.exit(0);
