# finviz-chart-scraper

Extract financial market data from [finviz.com](https://finviz.com) using Puppeteer network interception.

Supports: **stocks** (with sector/industry metadata), **futures** (with exchange info), **forex** pairs, and **chart data** (OHLCV time series).

## Setup

```bash
npm install
```

## Usage

```bash
# Chart data for a ticker (OHLCV CSV)
node cli.js chart AAPL              # daily
node cli.js chart AAPL w            # weekly
node cli.js chart AAPL m            # monthly

# Stock listings with metadata (sector, industry, country, market cap, P/E)
node cli.js stocks                  # all exchanges
node cli.js stocks nyse             # NYSE only
node cli.js stocks nasdaq           # NASDAQ only

# Futures contracts (with exchange, contract info)
node cli.js futures

# Forex pairs (with rates)
node cli.js forex
```

Or call scripts directly:

```bash
node scrape.js WOK d ./output          # chart data
node scrape-stocks.js nasdaq ./output   # stock listings
node scrape-futures.js ./output         # futures
node scrape-forex.js ./output           # forex
```

## Output

### Chart data (`scrape.js`)
- `output/<TICKER>_d.csv` — OHLCV time series
- `output/<TICKER>_metadata.json` — sector, industry, fundamentals

```csv
datetime,close,open,high,low,volume
2024-01-02T00:00:00.000Z,185.64,187.15,188.44,183.89,82488700
```

### Stock listings (`scrape-stocks.js`)
- `output/stocks_<exchange>.csv`

```csv
ticker,company,sector,industry,country,market_cap,pe,price,change,volume
AAPL,"Apple Inc.","Technology","Consumer Electronics",USA,3.54T,35.21,232.64,+0.52%,54321000
```

### Futures (`scrape-futures.js`)
- `output/futures.csv` + `output/futures_raw.json`

```csv
name,ticker,last,change,change_pct,exchange
Crude Oil,CL,103.38,+1.20,+1.17%,NYMEX
```

### Forex (`scrape-forex.js`)
- `output/forex.csv` + `output/forex_raw.json`

```csv
pair,base,quote,last,change,change_pct
EUR/USD,EUR,USD,1.1709,-0.0029,-0.25%
```

## How it works

All finviz pages load data asynchronously via JavaScript. Static HTML scraping doesn't work. This tool:

1. Launches headless Chrome via Puppeteer
2. Hides webdriver flag to avoid bot detection
3. Navigates to the target page, waits for JS to execute
4. Intercepts network responses for JSON/CSV data
5. Extracts data from the rendered DOM (tables, data attributes)
6. Parses multiple data formats (OHLCV objects, TradingView-style arrays)
7. Outputs as CSV

Raw responses are dumped to JSON for debugging when structured parsing fails.

## Troubleshooting

- **Navigation timeout**: Finviz may be slow or rate-limiting. Increase timeout in the script or retry.
- **No data found**: Check `output/*_raw.json` for the actual page content to tune parsing.
- **Rate limited (429)**: Wait ~15 minutes and retry.
- **Browser won't launch**: The scraper auto-detects system Chrome. Install Chrome or let Puppeteer download Chromium (`PUPPETEER_SKIP_DOWNLOAD=false npm install`).
