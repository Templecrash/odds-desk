# Odds Desk

Bull/bear odds for the top 100 crypto coins, with one-click long/short trading on Hyperliquid.

**Live app:** https://odds-desk-six.vercel.app

## What it does

- **10-minute mode (default):** scalp odds from Hyperliquid 1-minute candles, the live order book and recent trades. Every coin's setup is backtested on its own recent data by simulating the exact trade (take profit, stop, or exit at 10 minutes) after fees. Confidence comes from that result, not from the odds alone.
- **7-day mode:** odds researched by Claude from recent news (with sources for each coin), blended with a daily quant engine (9 technical strategies, each backtested per coin) and a macro score.
- **Macro:** a calendar of US data releases (CPI, jobs, Fed decisions and more). 10-minute trades pause around high-impact releases. Live S&P futures, dollar index and 10-year yield feed the macro score.
- **Flags:** ▲ RUN / ▼ RISK / ⇅ MOVE for buying or selling surges, breakouts, volatility squeezes, crowded bets and dated catalysts such as token unlocks.
- **Trading:** entry, stop-loss and take-profit levels for every coin. Leverage is set from the odds and confidence and capped so the stop comes before liquidation. Orders go to Hyperliquid with the stop and take-profit attached, plus an optional 10-minute auto-close.

## Using it

1. Open the live app. Odds, levels and the backtests work without any setup.
2. To trade, open **Settings** and add your Hyperliquid account address and an **API wallet** private key. Create one at app.hyperliquid.xyz → More → API. An API wallet can trade but can't withdraw. Never paste your main wallet's key.
3. The app starts on **testnet** (play money). Switch to mainnet in Settings only when you're comfortable.
4. Optional: add an Anthropic API key in Settings to refresh the 7-day research yourself or use other horizons.

Keys stay in your browser. Orders are signed in the page and sent only to Hyperliquid.

## How it's built

- `index.html`: the whole app (no build step)
- `quant.js`: quant engine: daily strategies, the 10-minute scalp engine, backtests, entry/exit levels, macro scoring
- `api/`: Vercel edge functions that relay Hyperliquid, CoinGecko and Yahoo Finance so the browser doesn't hit CORS limits
- `odds.json`: the latest Claude-researched 7-day odds, catalysts and macro calendar

Deploy your own copy by importing this repo into Vercel. No configuration needed.

## Important

This is an experiment, not financial advice. The AI odds are reasoned guesses, not calibrated probabilities. Backtests use a small recent sample and past results don't guarantee future ones. Most 10-minute setups lose money after fees, and the app will often tell you not to trade. Leverage magnifies losses. Use testnet first and only risk what you can afford to lose.
