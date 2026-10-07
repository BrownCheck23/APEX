# APEX — Adaptive Position EXecution

An AI-driven trading system. Entry and exit decisions are **deterministic** — driven by three quantitative
filters computed from daily OHLCV bars. Jev (TypeSafe AI) acts as a **regime classifier only**: it labels the
current market regime and flags whether conditions are coherent enough to act. Claude retunes the strategy every
50 completed trades. Robinhood is reached directly through its MCP server (`@modelcontextprotocol/sdk`, no LLM
in the data path).

**Paper trading is the default.** Nothing in this repo has been run against real Anthropic, TypeSafe or
Robinhood services. See [What has and has not been tested](#what-has-and-has-not-been-tested).

## Strategy

**Universe:** SPY and QQQ only.

**Schedule:** The bot runs once per day at 4:30 pm ET (30 minutes after market close), Monday–Friday.

**Entry conditions** (ALL must be true before Jev is consulted):
1. 12-month return is positive (momentum factor — price is rising on a yearly basis)
2. Current price is above the 200-day simple moving average (trend filter)
3. RSI-14 is between `rsiLowerBound` (default 35) and `rsiUpperBound` (default 65) — not already extended

**Jev's role (classifier, not decision-maker):**
Jev is called **once per cycle** (not per symbol) with market state derived from daily bars. It answers two questions:
1. *What is the current market regime?* — `trending_bullish` / `trending_bearish` / `ranging` / `volatile` / `unknown`
2. *Is current volatility and momentum coherent enough to act on signals?* — boolean

Jev can **veto** an entry (if regime is `volatile` or `trending_bearish`, or `isCoherent` is false). It cannot initiate one.

**Exit conditions** (first to trigger wins):
- 5% trailing stop from the highest price seen since entry
- Price breaks below the 200-day SMA
- Jev flags regime as `volatile` or `trending_bearish`

**Position sizing:** 40% of portfolio per position, 80% total deployed. `positionSizingFactor` (tuned by the evaluator) scales both.

## Why this approach

The previous design asked Jev to make buy/sell/hold calls directly. Empirically this produced a ~0.49 hit rate —
coin-flip decisions. The new design uses Jev for what LLM-class models are good at (regime and tone
classification) while leaving entry timing to deterministic rules with documented edge (momentum + trend-following).

## Setup

Requires Node 20+.

```bash
npm install
cp .env.example .env        # fill it in
```

| Variable | Needed for |
| --- | --- |
| `ANTHROPIC_API_KEY` | The self-improvement evaluator only (one call per 50 trades) |
| `TYPESAFE_AI_API_KEY` | Jev. `VERCEL_AI_GATEWAY_TOKEN` is accepted as a fallback |
| `ROBINHOOD_ACCOUNT_NUMBER`, `ROBINHOOD_RHS_ACCOUNT_NUMBER` | Live mode only |
| Robinhood login | `npm run robinhood:auth` once (see below). `ROBINHOOD_MCP_AUTH_TOKEN` can override with a manual token |

All other variables have the defaults in `.env.example`.

## Robinhood login (required for real data, even in paper mode)

Robinhood's MCP server uses OAuth 2.0 (authorization code + PKCE, dynamic client registration, refresh tokens).
APEX runs the flow itself:

```bash
npm run robinhood:auth      # once: registers a client, opens Robinhood login, stores the tokens
```

Tokens are saved to `data/robinhood-token.json` (gitignored) and refreshed automatically. APEX sends them only to
`agent.robinhood.com`.

Robinhood only lists specific clients (Claude Code, Cursor, …) and may reject unknown clients. If registration
fails the helper prints Robinhood's error and fallbacks: another port (`RH_AUTH_PORT`), or a manual token from
the MCP Inspector in `ROBINHOOD_MCP_AUTH_TOKEN`.

## What Robinhood's MCP provides

Run `npm run robinhood:tools` to see what the server currently offers.

| APEX needs | From Robinhood MCP? |
| --- | --- |
| Daily OHLCV historicals (for RSI, SMA, momentum) | `get_equity_historicals` — **assumed present, unverified** |
| Quotes, portfolio, positions, equity order review/placement | Yes (field names matched tolerantly) |
| Level 2 book, real-time indicators, earnings, scanner | **No.** Wrappers throw `CapabilityUnavailable` |
| Options chains, crypto quotes/orders | **No.** Disabled pending strategy validation |

The new daily strategy computes RSI-14, 200-day SMA and 12-month momentum **locally from historicals** — no
paid indicator service needed. If `get_equity_historicals` is not present on the server, the equity cycle fails
closed and logs a `CapabilityUnavailable` error.

## Cost controls

Claude is called only by the evaluator (one call per 50 trades). Jev is called once per daily cycle (not per
symbol). Options and crypto cycles are disabled.

| Setting | Default | Effect |
| --- | --- | --- |
| `APEX_CLAUDE_MODEL` | `claude-sonnet-4-6` | Evaluator model |
| `APEX_ENABLE_OPTIONS` / `APEX_ENABLE_CRYPTO` | true / true | Flags still in config; both strategies return immediately |

## Run

```bash
npm start            # bot + dashboard (runs at 4:30pm ET)
npm run dev          # same, restarts on file changes
npm start -- --once  # single cycle immediately (ignores market-hours check)
```

`PAPER_TRADING=true` is the default. Only the exact value `false` switches to live. In paper mode every
`place_*` wrapper throws before any network call.

### Run without any API calls

```bash
npm run verify       # 72 assertions: P&L math, kill switch, evaluator, signal math, hard constraints
npm run simulate     # bot cycles against a seeded fake market
```

`APEX_OFFLINE_SIM=true` replaces all external calls (MCP, Jev, evaluator) with deterministic local stand-ins.
The simulated P&L says nothing about real performance.

## Dashboard

`http://localhost:3001` (change with `DASHBOARD_PORT`). Starts with the bot, listens on 127.0.0.1 only.
`GET /status` and `GET /trades` return JSON. API keys are never serialised.

## Going live

> **Warning: live mode places real orders with real money.** APEX is unproven and has never traded.

1. Fill in both Robinhood account numbers and run `npm run robinhood:auth`.
2. Set `LIVE_STARTING_CAPITAL` if the kill switch should measure from a figure other than the first-launch account value.
3. Set `PAPER_TRADING=false` and restart.

In live mode every equity order goes through `review_equity_order` first. Any non-informational alert skips the trade.

## Behaviour worth knowing

**Kill switch** runs before every trade decision.
- Soft stop at -5% total loss: pauses, runs the evaluator, resumes.
- Hard stop at -10%: exits the process. Open positions are **not** closed.
- Confidence stop: 20 consecutive Jev decisions averaging below 0.52. Clears after 60-minute cooldown.

**Self-improvement.** After every 50 completed round-trip trades, Claude proposes new values for five tunable
fields: `confidenceThreshold`, `minCoherenceScore`, `positionSizingFactor`, `rsiLowerBound`, `rsiUpperBound`.
Each value is clamped to its absolute range and to a 20% move from the current value.

**No pyramiding.** Only one long position per symbol.

## Where this differs from earlier versions

- **Jev is now a classifier, not a decision-maker.** The previous version asked Jev to pick buy/sell/hold;
  empirically this was ~coin-flip. Jev now answers only regime and coherence questions.
- **Daily bars, not 15-minute cycles.** The equity cron moved from `*/15 9-15 * * 1-5` to `30 16 * * 1-5`.
- **Options and crypto disabled** pending strategy validation. Their cycles return immediately.
- **Signal math is local.** RSI-14, 200-day SMA, and 12-month momentum are computed from `get_equity_historicals`
  with no paid indicator service.
- **Evaluator tunes five fields** (added `rsiLowerBound` and `rsiUpperBound`; renamed `minShouldTradeScore` to
  `minCoherenceScore`).

## What has and has not been tested

Verified: `tsc --noEmit` is clean; `npm run verify` passes 72 assertions; the bot schedules correctly and serves
the dashboard.

Not verified: any call to the Anthropic API, the Robinhood MCP server, or TypeSafe/Jev. The OAuth helper has not
been run against Robinhood. `get_equity_historicals` field names in real responses are assumed — run
`npm run robinhood:tools -- --sample` after auth to verify the normaliser.
