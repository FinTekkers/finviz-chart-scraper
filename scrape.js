const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const TICKER = process.argv[2] || 'AAPL';
const TIMEFRAME = process.argv[3] || 'd'; // d=daily, w=weekly, m=monthly
const OUTPUT_DIR = process.argv[4] || './output';

async function scrape(ticker, timeframe) {
  console.error(`Scraping ${ticker} (timeframe=${timeframe})...`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

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
  await page.goto(quoteUrl, { waitUntil: 'networkidle2', timeout: 30000 });

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

  return chartData;
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
    const data = await scrape(TICKER, TIMEFRAME);
    const csv = toCsv(data, true);

    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const outFile = path.join(OUTPUT_DIR, `${TICKER}_${TIMEFRAME}.csv`);
    fs.writeFileSync(outFile, csv);
    console.error(`Wrote ${data.length} data points to ${outFile}`);

    // Also print to stdout for piping
    console.log(csv);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
})();
