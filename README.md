# finviz-chart-scraper

Extract historical price data from [finviz.com](https://finviz.com) stock charts as CSV.

Finviz loads chart data asynchronously via JavaScript. This tool uses Puppeteer to load the page in a headless browser, intercept network responses, and extract the underlying price data.

## Setup

```bash
npm install
```

## Usage

```bash
# Basic: scrape daily chart data for a ticker
node scrape.js AAPL

# Specify timeframe: d=daily, w=weekly, m=monthly
node scrape.js AAPL w

# Custom output directory
node scrape.js AAPL d ./data

# Pipe CSV to stdout
node scrape.js AAPL 2>/dev/null | head
```

## Output

CSV with columns: `datetime,close,open,high,low,volume`

```
datetime,close,open,high,low,volume
2024-01-02T00:00:00.000Z,185.64,187.15,188.44,183.89,82488700
2024-01-03T00:00:00.000Z,184.25,184.22,185.88,183.43,58414500
...
```

Files are written to `./output/<TICKER>_<timeframe>.csv`.

## How it works

1. Launches a headless Chrome via Puppeteer
2. Navigates to the finviz quote page with chart enabled
3. Intercepts all network responses, looking for JSON/CSV chart data
4. Parses multiple data formats (OHLCV objects, TradingView-style arrays, CSV)
5. Also checks inline `<script type="application/json">` blocks and global JS variables
6. Deduplicates and sorts by date
7. Outputs as CSV

If no structured data is found in network responses, raw response bodies are dumped to `output/<TICKER>_raw_responses.json` for debugging.

## Troubleshooting

- **No data found**: Finviz may rate-limit or block headless browsers. Try adding a delay or using `headless: false` in `scrape.js`.
- **Browser won't launch**: Ensure Chrome/Chromium is installed. Puppeteer downloads its own Chromium by default.
- **Rate limited (429)**: Wait and retry. Finviz limits requests per IP.
