const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

function findChrome() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const TICKER = process.argv[2] || 'AAPL';
const TIMEFRAME = process.argv[3] || 'd'; // d=daily, w=weekly, m=monthly
const OUTPUT_DIR = process.argv[4] || './output';

async function scrape(ticker, timeframe) {
  console.error(`Scraping ${ticker} (timeframe=${timeframe})...`);

  const chromePath = findChrome();
  const launchOpts = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
    protocolTimeout: 120000,
  };
  if (chromePath) {
    launchOpts.executablePath = chromePath;
    console.error(`Using system Chrome: ${chromePath}`);
  }
  const browser = await puppeteer.launch(launchOpts);

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  // Hide webdriver flag to avoid bot detection
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const captured = [];

  page.on('response', async (response) => {
    const url = response.url();
    const status = response.status();
    if (status < 200 || status >= 300) return;

    const isChartData =
      url.includes('charts2-node') ||
      url.includes('chart') ||
      url.includes('candle') ||
      url.includes('history') ||
      url.includes('time_series');

    const ct = (response.headers()['content-type'] || '').toLowerCase();
    const isJson = ct.includes('json');
    const isRelevant = isChartData || isJson;

    if (!isRelevant) return;

    try {
      const text = await response.text();
      captured.push({ url, contentType: ct, body: text });
    } catch (_) {}
  });

  const quoteUrl = `https://finviz.com/quote.ashx?t=${ticker}&ta=1&p=${timeframe}`;
  console.error(`Navigating to ${quoteUrl}...`);
  await page.goto(quoteUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.error('Page loaded, waiting for chart data...');

  // Wait for network to settle (chart data loads async)
  await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});

  // Wait for chart to render — the chart loads asynchronously
  await page.waitForFunction(
    () => document.querySelector('canvas') !== null,
    { timeout: 15000 }
  ).catch(() => console.error('No canvas found — chart may not have loaded'));

  // Give async chart data a moment to arrive
  await new Promise((r) => setTimeout(r, 3000));

  // Also try to extract data from the page's JavaScript context
  const inlineData = await page.evaluate(() => {
    const results = {};

    // Look for chart data in global variables
    if (window.FinvizChartData) results.FinvizChartData = window.FinvizChartData;
    if (window.chartData) results.chartData = window.chartData;
    if (window.priceData) results.priceData = window.priceData;

    // Look for any JSON script blocks with chart data
    const scripts = document.querySelectorAll('script[type="application/json"]');
    scripts.forEach((s, i) => {
      try {
        const data = JSON.parse(s.textContent);
        if (
          Array.isArray(data) &&
          data.length > 0 &&
          (data[0].date || data[0].time || data[0].t || data[0].timestamp)
        ) {
          results[`scriptBlock_${i}`] = data;
        }
      } catch (_) {}
    });

    // Try to find chart instance data
    const canvases = document.querySelectorAll('canvas');
    canvases.forEach((c, i) => {
      if (c.__chart__) results[`canvas_${i}`] = c.__chart__;
    });

    return results;
  });

  // Extract stock metadata (sector, industry, fundamentals)
  const metadata = await page.evaluate(() => {
    const data = {};
    const cells = document.querySelectorAll('td.snapshot-td2');
    const labels = document.querySelectorAll('td.snapshot-td2-cp');
    if (cells.length === 0) {
      // Alternative selector patterns
      const allTds = document.querySelectorAll('table td');
      const kvPairs = [];
      for (let i = 0; i < allTds.length - 1; i++) {
        const key = allTds[i].textContent.trim();
        const val = allTds[i + 1].textContent.trim();
        if (['Index', 'Sector', 'Industry', 'Country', 'Exchange', 'Market Cap',
             'P/E', 'EPS (ttm)', 'Insider Own', 'Inst Own', 'Short Float',
             'Dividend', 'Dividend %', 'Beta', '52W High', '52W Low',
             'RSI (14)', 'Avg Volume', 'Volume', 'Perf Week', 'Perf Month',
             'Perf Quarter', 'Perf Half Y', 'Perf Year', 'Perf YTD',
             'Employees', 'Optionable', 'Shortable', 'Earnings',
             'SMA20', 'SMA50', 'SMA200'].includes(key)) {
          data[key] = val;
        }
      }
    } else {
      for (let i = 0; i < labels.length && i < cells.length; i++) {
        data[labels[i].textContent.trim()] = cells[i].textContent.trim();
      }
    }
    return data;
  });


  await browser.close();

  // Parse captured network responses for chart data
  const chartData = extractChartData(captured, inlineData);

  if (chartData.length === 0) {
    console.error('No chart data found in network responses.');
    console.error(`Captured ${captured.length} relevant responses:`);
    for (const c of captured) {
      console.error(`  ${c.url.substring(0, 120)} [${c.contentType}] (${c.body.length} bytes)`);
      if (c.body.length < 500) console.error(`    ${c.body.substring(0, 200)}`);
    }
    dumpRawResponses(captured, ticker);
    process.exit(1);
  }

  return { chartData, metadata };
}

function extractChartData(captured, inlineData) {
  const points = [];

  for (const resp of captured) {
    try {
      const data = JSON.parse(resp.body);
      const extracted = parseDataShape(data);
      if (extracted.length > 0) {
        points.push(...extracted);
        console.error(`Extracted ${extracted.length} points from ${resp.url.substring(0, 80)}`);
      }
    } catch (_) {
      // Try as CSV
      const lines = resp.body.split('\n').filter((l) => l.trim());
      if (lines.length > 5 && lines[0].includes(',')) {
        for (const line of lines.slice(1)) {
          const parts = line.split(',');
          if (parts.length >= 2) {
            const dt = parseDate(parts[0]);
            const val = parseFloat(parts[1]);
            if (dt && !isNaN(val)) points.push({ datetime: dt, value: val });
          }
        }
        if (points.length > 0) {
          console.error(`Extracted ${points.length} CSV points from ${resp.url.substring(0, 80)}`);
        }
      }
    }
  }

  // Also check inline data
  for (const [key, data] of Object.entries(inlineData || {})) {
    const extracted = parseDataShape(data);
    if (extracted.length > 0) {
      points.push(...extracted);
      console.error(`Extracted ${extracted.length} points from inline ${key}`);
    }
  }

  return dedup(points);
}

function parseDataShape(data) {
  const points = [];

  // Array of OHLCV objects: [{date, open, high, low, close, volume}, ...]
  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item !== 'object' || item === null) continue;
      const dt = parseDate(item.date || item.time || item.t || item.timestamp || item.Date || item.Time);
      const val =
        item.close ?? item.Close ?? item.price ?? item.Price ?? item.value ?? item.Value ?? item.c;
      if (dt && val !== undefined && !isNaN(parseFloat(val))) {
        points.push({
          datetime: dt,
          value: parseFloat(val),
          open: parseFloat(item.open ?? item.Open ?? item.o ?? ''),
          high: parseFloat(item.high ?? item.High ?? item.h ?? ''),
          low: parseFloat(item.low ?? item.Low ?? item.l ?? ''),
          volume: parseFloat(item.volume ?? item.Volume ?? item.v ?? ''),
        });
      }
    }
    return points;
  }

  // Nested: { candles: [...] } or { data: [...] } or { results: [...] }
  if (typeof data === 'object' && data !== null) {
    for (const key of ['candles', 'data', 'results', 'series', 'values', 'chart', 'prices', 'bars']) {
      if (Array.isArray(data[key])) {
        const sub = parseDataShape(data[key]);
        if (sub.length > 0) return sub;
      }
    }
    // TradingView-style: { t: [timestamps], c: [closes], o: [...], h: [...], l: [...], v: [...] }
    if (Array.isArray(data.t) && Array.isArray(data.c)) {
      for (let i = 0; i < data.t.length; i++) {
        const dt = parseDate(data.t[i]);
        if (dt) {
          points.push({
            datetime: dt,
            value: data.c[i],
            open: data.o?.[i],
            high: data.h?.[i],
            low: data.l?.[i],
            volume: data.v?.[i],
          });
        }
      }
      return points;
    }
  }

  return points;
}

function parseDate(val) {
  if (!val) return null;
  if (typeof val === 'number') {
    // Unix seconds or milliseconds
    const ts = val > 1e12 ? val : val * 1000;
    const d = new Date(ts);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof val === 'string') {
    const d = new Date(val);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function dedup(points) {
  const seen = new Set();
  return points.filter((p) => {
    const key = `${p.datetime}_${p.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dumpRawResponses(captured, ticker) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const dumpFile = path.join(OUTPUT_DIR, `${ticker}_raw_responses.json`);
  const dump = captured.map((c) => ({
    url: c.url,
    contentType: c.contentType,
    bodyLength: c.body.length,
    bodyPreview: c.body.substring(0, 2000),
  }));
  fs.writeFileSync(dumpFile, JSON.stringify(dump, null, 2));
  console.error(`Raw responses dumped to ${dumpFile}`);
}

function toCsv(points, includeOhlcv) {
  const hasOhlcv = includeOhlcv && points.some((p) => !isNaN(p.open));
  const header = hasOhlcv
    ? 'datetime,close,open,high,low,volume'
    : 'datetime,value';

  const rows = points
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime))
    .map((p) => {
      if (hasOhlcv) {
        return `${p.datetime},${p.value},${p.open || ''},${p.high || ''},${p.low || ''},${p.volume || ''}`;
      }
      return `${p.datetime},${p.value}`;
    });

  return [header, ...rows].join('\n');
}

(async () => {
  try {
    const { chartData, metadata } = await scrape(TICKER, TIMEFRAME);
    const csv = toCsv(chartData, true);

    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const outFile = path.join(OUTPUT_DIR, `${TICKER}_${TIMEFRAME}.csv`);
    fs.writeFileSync(outFile, csv);
    console.error(`Wrote ${chartData.length} data points to ${outFile}`);

    // Write metadata
    if (metadata && Object.keys(metadata).length > 0) {
      const metaFile = path.join(OUTPUT_DIR, `${TICKER}_metadata.json`);
      fs.writeFileSync(metaFile, JSON.stringify(metadata, null, 2));
      console.error(`Wrote metadata (${Object.keys(metadata).length} fields) to ${metaFile}`);
    }

    // Also print to stdout for piping
    console.log(csv);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
})();
