const fs = require('fs');
const path = require('path');
const { launchBrowser, newPage, navigateAndWait, ensureDir } = require('./lib/browser');

const OUTPUT_DIR = process.argv[3] || './output';

async function scrapeFutures() {
  const browser = await launchBrowser();
  const page = await newPage(browser);

  await navigateAndWait(page, 'https://finviz.com/futures', 5000);

  const futures = await page.evaluate(() => {
    const results = [];

    // Try multiple selector strategies for the futures table
    // Strategy 1: look for table rows with futures data
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const rows = table.querySelectorAll('tr');
      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 4) {
          const text = Array.from(cells).map((c) => c.textContent.trim());
          // Futures rows typically have: label, ticker/last, change, %change
          if (text.some((t) => /^[A-Z]{1,4}$/.test(t)) || text.some((t) => /^[\d,.]+$/.test(t))) {
            results.push({ cells: text });
          }
        }
      }
    }

    // Strategy 2: look for links with futures ticker patterns
    const links = document.querySelectorAll('a[href*="futures"]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const text = link.textContent.trim();
      if (text && href.includes('_') && !href.includes('.js') && !href.includes('.css')) {
        results.push({ link: href, text });
      }
    }

    // Strategy 3: extract from any structured data containers
    const containers = document.querySelectorAll('[class*="futures"], [class*="commodity"], [data-ticker]');
    for (const el of containers) {
      results.push({
        tag: el.tagName,
        classes: el.className,
        text: el.textContent.trim().substring(0, 200),
        ticker: el.getAttribute('data-ticker'),
      });
    }

    // Strategy 4: get ALL text content from the main content area to understand page structure
    const main = document.querySelector('#root') || document.querySelector('main') || document.body;
    const allText = main ? main.innerText : '';

    return { structured: results, pageText: allText.substring(0, 10000) };
  });

  await browser.close();

  ensureDir(OUTPUT_DIR);
  const outFile = path.join(OUTPUT_DIR, 'futures_raw.json');
  fs.writeFileSync(outFile, JSON.stringify(futures, null, 2));
  console.error(`Futures data written to ${outFile}`);

  // Try to parse the structured data into CSV
  const parsed = parseFuturesData(futures);
  if (parsed.length > 0) {
    const csvFile = path.join(OUTPUT_DIR, 'futures.csv');
    const header = 'name,ticker,last,change,change_pct,exchange';
    const rows = parsed.map((f) =>
      `${f.name},${f.ticker},${f.last},${f.change},${f.changePct},${f.exchange}`
    );
    fs.writeFileSync(csvFile, [header, ...rows].join('\n'));
    console.error(`Wrote ${parsed.length} futures to ${csvFile}`);
    console.log([header, ...rows].join('\n'));
  } else {
    console.error('Could not parse structured futures data. Check futures_raw.json for page content.');
    console.error('Page text preview:');
    console.error(futures.pageText?.substring(0, 2000));
  }
}

function parseFuturesData(raw) {
  const results = [];

  // Known finviz futures tickers and their exchanges
  const FUTURES_META = {
    ES: { name: 'S&P 500 E-Mini', exchange: 'CME' },
    NQ: { name: 'Nasdaq 100 E-Mini', exchange: 'CME' },
    YM: { name: 'Dow Jones E-Mini', exchange: 'CBOT' },
    ER2: { name: 'Russell 2000 E-Mini', exchange: 'CME' },
    CL: { name: 'Crude Oil', exchange: 'NYMEX' },
    NG: { name: 'Natural Gas', exchange: 'NYMEX' },
    GC: { name: 'Gold', exchange: 'COMEX' },
    SI: { name: 'Silver', exchange: 'COMEX' },
    HG: { name: 'Copper', exchange: 'COMEX' },
    PL: { name: 'Platinum', exchange: 'NYMEX' },
    PA: { name: 'Palladium', exchange: 'NYMEX' },
    ZC: { name: 'Corn', exchange: 'CBOT' },
    ZW: { name: 'Wheat', exchange: 'CBOT' },
    ZS: { name: 'Soybeans', exchange: 'CBOT' },
    ZM: { name: 'Soybean Meal', exchange: 'CBOT' },
    ZL: { name: 'Soybean Oil', exchange: 'CBOT' },
    CT: { name: 'Cotton', exchange: 'ICE' },
    KC: { name: 'Coffee', exchange: 'ICE' },
    SB: { name: 'Sugar', exchange: 'ICE' },
    CC: { name: 'Cocoa', exchange: 'ICE' },
    LB: { name: 'Lumber', exchange: 'CME' },
    LE: { name: 'Live Cattle', exchange: 'CME' },
    HE: { name: 'Lean Hogs', exchange: 'CME' },
    ZB: { name: 'US Treasury Bond', exchange: 'CBOT' },
    ZN: { name: 'US 10-Year Note', exchange: 'CBOT' },
    ZF: { name: 'US 5-Year Note', exchange: 'CBOT' },
    ZT: { name: 'US 2-Year Note', exchange: 'CBOT' },
    '6E': { name: 'Euro FX', exchange: 'CME' },
    '6J': { name: 'Japanese Yen', exchange: 'CME' },
    '6B': { name: 'British Pound', exchange: 'CME' },
    '6A': { name: 'Australian Dollar', exchange: 'CME' },
    '6C': { name: 'Canadian Dollar', exchange: 'CME' },
    DX: { name: 'US Dollar Index', exchange: 'ICE' },
    RB: { name: 'RBOB Gasoline', exchange: 'NYMEX' },
    HO: { name: 'Heating Oil', exchange: 'NYMEX' },
    BZ: { name: 'Brent Crude', exchange: 'NYMEX' },
    VX: { name: 'VIX', exchange: 'CFE' },
  };

  // Try to extract from page text using line-by-line parsing
  if (raw.pageText) {
    const lines = raw.pageText.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match patterns like "Crude Oil  103.38  +1.20  +1.17%"
      const match = line.match(
        /^(.+?)\s+([\d,.]+)\s+([+-]?[\d,.]+)\s+([+-]?[\d,.]+%?)$/
      );
      if (match) {
        const name = match[1].trim();
        const ticker = Object.entries(FUTURES_META).find(
          ([_, v]) => v.name.toLowerCase() === name.toLowerCase()
        )?.[0] || '';
        results.push({
          name,
          ticker,
          last: match[2],
          change: match[3],
          changePct: match[4],
          exchange: FUTURES_META[ticker]?.exchange || '',
        });
      }
    }
  }

  return results;
}

scrapeFutures().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
