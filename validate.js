const fs = require('fs');
const path = require('path');
const https = require('https');

const OUTPUT_DIR = process.argv[2] || './output';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${data.substring(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

async function yahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  const data = await fetchJson(url);
  const r = data.chart?.result?.[0];
  if (!r) throw new Error(`No Yahoo data for ${symbol}`);
  return {
    symbol: r.meta.symbol,
    price: r.meta.regularMarketPrice,
    exchange: r.meta.fullExchangeName,
    type: r.meta.instrumentType,
    currency: r.meta.currency,
    fiftyTwoWeekHigh: r.meta.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: r.meta.fiftyTwoWeekLow,
    longName: r.meta.longName,
  };
}

async function yahooHistory(symbol, range = '6mo') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const data = await fetchJson(url);
  const r = data.chart?.result?.[0];
  if (!r) return [];
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  return ts.map((t, i) => ({
    date: new Date(t * 1000).toISOString().split('T')[0],
    open: q.open?.[i],
    high: q.high?.[i],
    low: q.low?.[i],
    close: q.close?.[i],
    volume: q.volume?.[i],
  })).filter((p) => p.close != null);
}

function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const vals = line.split(',');
    const obj = {};
    header.forEach((h, i) => (obj[h.trim()] = vals[i]?.trim()));
    return obj;
  });
}

function pctDiff(a, b) {
  if (b === 0) return a === 0 ? 0 : Infinity;
  return Math.abs(a - b) / Math.abs(b) * 100;
}

async function checkStocks() {
  console.log('\n═══ STOCK DATA QUALITY CHECK ═══\n');

  const stockFiles = fs.readdirSync(OUTPUT_DIR).filter((f) => f.startsWith('stocks_') && f.endsWith('.csv'));
  if (stockFiles.length === 0) {
    console.log('No stock CSV files found in output/. Run: node cli.js stocks');
    return;
  }

  for (const file of stockFiles) {
    const stocks = readCsv(path.join(OUTPUT_DIR, file));
    if (!stocks || stocks.length === 0) {
      console.log(`${file}: EMPTY`);
      continue;
    }

    console.log(`${file}: ${stocks.length} stocks`);

    // Spot check 5 random stocks
    const sample = [];
    const indices = new Set();
    while (sample.length < Math.min(5, stocks.length)) {
      const idx = Math.floor(Math.random() * stocks.length);
      if (!indices.has(idx)) {
        indices.add(idx);
        sample.push(stocks[idx]);
      }
    }

    let pass = 0, fail = 0, warn = 0;

    for (const stock of sample) {
      const ticker = stock.ticker;
      if (!ticker) continue;

      try {
        const yahoo = await yahooQuote(ticker);
        const finvizPrice = parseFloat(stock.price);
        const yahooPrice = yahoo.price;

        const diff = pctDiff(finvizPrice, yahooPrice);
        const status = diff < 2 ? 'OK' : diff < 5 ? 'WARN' : 'FAIL';

        if (status === 'OK') pass++;
        else if (status === 'WARN') warn++;
        else fail++;

        console.log(`  ${ticker}: finviz=${finvizPrice} yahoo=${yahooPrice.toFixed(2)} diff=${diff.toFixed(1)}% [${status}]`);

        // Check metadata
        if (stock.sector && stock.sector !== '-') {
          console.log(`    Sector: ${stock.sector} | Industry: ${stock.industry} | Exchange: ${yahoo.exchange}`);
        }
      } catch (err) {
        console.log(`  ${ticker}: Yahoo lookup failed — ${err.message}`);
        warn++;
      }

      await sleep(500);
    }

    console.log(`  Summary: ${pass} OK, ${warn} WARN, ${fail} FAIL out of ${sample.length} checked\n`);
  }
}

async function checkChart() {
  console.log('\n═══ CHART DATA QUALITY CHECK ═══\n');

  const chartFiles = fs.readdirSync(OUTPUT_DIR).filter((f) => f.match(/^[A-Z]+_[dwm]\.csv$/));
  if (chartFiles.length === 0) {
    console.log('No chart CSV files found. Run: node cli.js chart AAPL');
    return;
  }

  for (const file of chartFiles) {
    const ticker = file.split('_')[0];
    const data = readCsv(path.join(OUTPUT_DIR, file));
    if (!data || data.length === 0) {
      console.log(`${file}: EMPTY`);
      continue;
    }

    console.log(`${file}: ${data.length} data points`);
    console.log(`  Date range: ${data[0].datetime} to ${data[data.length - 1].datetime}`);

    // Compare against Yahoo history
    try {
      const yahooData = await yahooHistory(ticker, '6mo');
      console.log(`  Yahoo has ${yahooData.length} days in same range`);

      // Match dates and compare closes
      let matched = 0, totalDiff = 0;
      for (const yRow of yahooData.slice(-10)) {
        const fRow = data.find((d) => d.datetime?.startsWith(yRow.date));
        if (fRow) {
          const fClose = parseFloat(fRow.close || fRow.value);
          const yClose = yRow.close;
          const diff = pctDiff(fClose, yClose);
          totalDiff += diff;
          matched++;
          const status = diff < 1 ? 'OK' : diff < 3 ? 'WARN' : 'FAIL';
          console.log(`    ${yRow.date}: finviz=${fClose} yahoo=${yClose.toFixed(2)} diff=${diff.toFixed(2)}% [${status}]`);
        }
      }

      if (matched > 0) {
        console.log(`  Avg diff: ${(totalDiff / matched).toFixed(2)}% over ${matched} matched days`);
      } else {
        console.log('  No date matches found — possible date format mismatch');
      }
    } catch (err) {
      console.log(`  Yahoo comparison failed: ${err.message}`);
    }

    console.log();
  }
}

async function checkFutures() {
  console.log('\n═══ FUTURES DATA QUALITY CHECK ═══\n');

  const csvFile = path.join(OUTPUT_DIR, 'futures.csv');
  const data = readCsv(csvFile);
  if (!data || data.length === 0) {
    console.log('No futures.csv found. Run: node cli.js futures');
    return;
  }

  console.log(`futures.csv: ${data.length} contracts`);

  const YAHOO_MAP = {
    ES: 'ES=F', NQ: 'NQ=F', YM: 'YM=F', CL: 'CL=F', NG: 'NG=F',
    GC: 'GC=F', SI: 'SI=F', HG: 'HG=F', ZB: 'ZB=F', ZN: 'ZN=F',
    ER2: 'RTY=F',
  };

  let pass = 0, fail = 0, warn = 0;
  for (const row of data) {
    const yahooSym = YAHOO_MAP[row.ticker];
    if (!yahooSym) continue;

    try {
      const yahoo = await yahooQuote(yahooSym);
      const finvizPrice = parseFloat(row.last?.replace(/,/g, ''));
      const diff = pctDiff(finvizPrice, yahoo.price);
      const status = diff < 2 ? 'OK' : diff < 5 ? 'WARN' : 'FAIL';

      if (status === 'OK') pass++;
      else if (status === 'WARN') warn++;
      else fail++;

      console.log(`  ${row.ticker} (${row.name}): finviz=${finvizPrice} yahoo=${yahoo.price.toFixed(2)} diff=${diff.toFixed(1)}% [${status}]`);
    } catch (err) {
      console.log(`  ${row.ticker}: Yahoo lookup failed — ${err.message}`);
      warn++;
    }

    await sleep(500);
  }

  console.log(`  Summary: ${pass} OK, ${warn} WARN, ${fail} FAIL\n`);
}

async function checkForex() {
  console.log('\n═══ FOREX DATA QUALITY CHECK ═══\n');

  const csvFile = path.join(OUTPUT_DIR, 'forex.csv');
  const data = readCsv(csvFile);
  if (!data || data.length === 0) {
    console.log('No forex.csv found. Run: node cli.js forex');
    return;
  }

  console.log(`forex.csv: ${data.length} pairs`);

  let pass = 0, fail = 0, warn = 0;
  for (const row of data) {
    const pair = row.pair?.replace('/', '');
    if (!pair) continue;

    const yahooSym = `${pair}=X`;
    try {
      const yahoo = await yahooQuote(yahooSym);
      const finvizRate = parseFloat(row.last);
      const diff = pctDiff(finvizRate, yahoo.price);
      const status = diff < 1 ? 'OK' : diff < 3 ? 'WARN' : 'FAIL';

      if (status === 'OK') pass++;
      else if (status === 'WARN') warn++;
      else fail++;

      console.log(`  ${row.pair}: finviz=${finvizRate} yahoo=${yahoo.price.toFixed(4)} diff=${diff.toFixed(2)}% [${status}]`);
    } catch (err) {
      console.log(`  ${row.pair}: Yahoo lookup failed — ${err.message}`);
      warn++;
    }

    await sleep(500);
  }

  console.log(`  Summary: ${pass} OK, ${warn} WARN, ${fail} FAIL\n`);
}

async function checkMetadata() {
  console.log('\n═══ METADATA QUALITY CHECK ═══\n');

  const metaFiles = fs.readdirSync(OUTPUT_DIR).filter((f) => f.endsWith('_metadata.json'));
  if (metaFiles.length === 0) {
    console.log('No metadata files found. Run: node cli.js chart AAPL');
    return;
  }

  for (const file of metaFiles) {
    const ticker = file.replace('_metadata.json', '');
    const meta = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, file), 'utf8'));
    const fields = Object.keys(meta);

    console.log(`${file}: ${fields.length} fields`);

    // Check key fields exist
    const expected = ['Sector', 'Industry', 'Country', 'Market Cap', 'P/E', 'Beta'];
    const missing = expected.filter((f) => !meta[f] && !meta[f.toLowerCase()]);
    if (missing.length > 0) {
      console.log(`  Missing fields: ${missing.join(', ')}`);
    } else {
      console.log(`  All key fields present`);
    }

    // Cross-check with Yahoo
    try {
      const yahoo = await yahooQuote(ticker);
      console.log(`  Sector: ${meta.Sector || meta.sector || 'N/A'}`);
      console.log(`  Industry: ${meta.Industry || meta.industry || 'N/A'}`);
      console.log(`  Yahoo name: ${yahoo.longName}`);
      console.log(`  Yahoo exchange: ${yahoo.exchange}`);

      if (meta['52W High'] && yahoo.fiftyTwoWeekHigh) {
        const fHigh = parseFloat(meta['52W High']);
        const diff = pctDiff(fHigh, yahoo.fiftyTwoWeekHigh);
        console.log(`  52W High: finviz=${fHigh} yahoo=${yahoo.fiftyTwoWeekHigh.toFixed(2)} diff=${diff.toFixed(1)}%`);
      }
    } catch (err) {
      console.log(`  Yahoo check failed: ${err.message}`);
    }

    console.log();
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  console.log('Finviz Data Quality Validator');
  console.log(`Checking output in: ${OUTPUT_DIR}\n`);

  if (!fs.existsSync(OUTPUT_DIR)) {
    console.log(`Output directory not found: ${OUTPUT_DIR}`);
    console.log('Run the scrapers first, then re-run this script.');
    process.exit(1);
  }

  const files = fs.readdirSync(OUTPUT_DIR);
  console.log(`Found ${files.length} files in output/\n`);

  await checkStocks();
  await checkChart();
  await checkFutures();
  await checkForex();
  await checkMetadata();

  console.log('═══ VALIDATION COMPLETE ═══');
})();
