const fs = require('fs');
const path = require('path');
const { launchBrowser, newPage, navigateAndWait, ensureDir } = require('./lib/browser');

const OUTPUT_DIR = process.argv[3] || './output';

async function scrapeForex() {
  const browser = await launchBrowser();
  const page = await newPage(browser);

  await navigateAndWait(page, 'https://finviz.com/forex', 5000);

  const forex = await page.evaluate(() => {
    const results = [];

    // Look for forex pair elements
    const links = document.querySelectorAll('a');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const text = link.textContent.trim();
      // FX pairs are typically like "EUR/USD" or links to forex_detail
      if (/[A-Z]{3}\/[A-Z]{3}/.test(text) || href.includes('forex')) {
        results.push({ href, text });
      }
    }

    // Look for elements with ticker/pair data attributes
    const tickerEls = document.querySelectorAll('[data-ticker], [data-pair], [class*="forex"]');
    for (const el of tickerEls) {
      results.push({
        tag: el.tagName,
        text: el.textContent.trim().substring(0, 200),
        ticker: el.getAttribute('data-ticker'),
        pair: el.getAttribute('data-pair'),
      });
    }

    // Get the full page text
    const main = document.querySelector('#root') || document.body;
    return { structured: results, pageText: main.innerText.substring(0, 10000) };
  });

  await browser.close();

  ensureDir(OUTPUT_DIR);
  const rawFile = path.join(OUTPUT_DIR, 'forex_raw.json');
  fs.writeFileSync(rawFile, JSON.stringify(forex, null, 2));
  console.error(`Forex raw data written to ${rawFile}`);

  const parsed = parseForexData(forex);
  if (parsed.length > 0) {
    const csvFile = path.join(OUTPUT_DIR, 'forex.csv');
    const header = 'pair,base,quote,last,change,change_pct';
    const rows = parsed.map((f) =>
      `${f.pair},${f.base},${f.quote},${f.last},${f.change},${f.changePct}`
    );
    fs.writeFileSync(csvFile, [header, ...rows].join('\n'));
    console.error(`Wrote ${parsed.length} forex pairs to ${csvFile}`);
    console.log([header, ...rows].join('\n'));
  } else {
    console.error('Could not parse forex data. Check forex_raw.json.');
    console.error(forex.pageText?.substring(0, 2000));
  }
}

function parseForexData(raw) {
  const results = [];

  // Known major/minor FX pairs
  const PAIRS = [
    'EUR/USD', 'USD/JPY', 'GBP/USD', 'AUD/USD', 'USD/CAD', 'USD/CHF', 'NZD/USD',
    'EUR/GBP', 'EUR/JPY', 'GBP/JPY', 'AUD/JPY', 'EUR/AUD', 'EUR/CAD', 'EUR/CHF',
    'GBP/CHF', 'GBP/AUD', 'AUD/CAD', 'AUD/NZD', 'NZD/JPY', 'CAD/JPY', 'CHF/JPY',
    'BTC/USD', 'ETH/USD',
  ];

  if (raw.pageText) {
    const lines = raw.pageText.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match "EUR/USD  1.1709  -0.0029  -0.25%"
      const match = line.match(
        /([A-Z]{3}\/[A-Z]{3})\s+([\d,.]+)\s+([+-]?[\d,.]+)\s+([+-]?[\d,.]+%)/
      );
      if (match) {
        const pair = match[1];
        results.push({
          pair,
          base: pair.split('/')[0],
          quote: pair.split('/')[1],
          last: match[2],
          change: match[3],
          changePct: match[4],
        });
      }
    }

    // Also try matching "EURUSD" format
    if (results.length === 0) {
      for (const line of lines) {
        const match = line.match(
          /([A-Z]{6,8})\s+([\d,.]+)\s+([+-]?[\d,.]+)\s+([+-]?[\d,.]+%)/
        );
        if (match) {
          const sym = match[1];
          if (sym.length === 6) {
            results.push({
              pair: `${sym.substring(0, 3)}/${sym.substring(3)}`,
              base: sym.substring(0, 3),
              quote: sym.substring(3),
              last: match[2],
              change: match[3],
              changePct: match[4],
            });
          }
        }
      }
    }
  }

  return results;
}

scrapeForex().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
