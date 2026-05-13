const fs = require('fs');
const path = require('path');
const { launchBrowser, newPage, navigateAndWait, ensureDir } = require('./lib/browser');

const EXCHANGE = process.argv[2] || ''; // e.g. "nyse", "nasdaq", "amex", or empty for all
const OUTPUT_DIR = process.argv[3] || './output';

// Finviz screener overview URL — paginated, 20 rows per page
// v=111 = overview, v=161 = industry/sector detail
function screenerUrl(offset, exchange) {
  let url = `https://finviz.com/screener.ashx?v=111&o=ticker&r=${offset + 1}`;
  if (exchange) {
    const exchMap = { nyse: 'exch_nyse', nasdaq: 'exch_nasd', amex: 'exch_amex' };
    const filter = exchMap[exchange.toLowerCase()];
    if (filter) url += `&f=${filter}`;
  }
  return url;
}

async function scrapeScreener(exchange) {
  const browser = await launchBrowser();
  const page = await newPage(browser);

  let allStocks = [];
  let offset = 0;
  let totalFound = 0;
  const PAGE_SIZE = 20;

  // First page to get total count
  await navigateAndWait(page, screenerUrl(0, exchange), 3000);

  // Get total results count
  totalFound = await page.evaluate(() => {
    // Finviz shows "Total: 8437" or similar
    const totalEl = document.querySelector('#screener-total') ||
      Array.from(document.querySelectorAll('td')).find(
        (td) => td.textContent.includes('Total:') || td.textContent.includes('#')
      );
    if (totalEl) {
      const match = totalEl.textContent.match(/(\d[\d,]*)/);
      if (match) return parseInt(match[1].replace(/,/g, ''), 10);
    }
    // Fallback: look in page text
    const bodyText = document.body.innerText;
    const totalMatch = bodyText.match(/Total:\s*([\d,]+)/i);
    if (totalMatch) return parseInt(totalMatch[1].replace(/,/g, ''), 10);
    return 0;
  });

  console.error(`Total stocks found: ${totalFound || 'unknown'}`);

  // Scrape pages
  const MAX_PAGES = 50; // safety limit: 50 pages × 20 = 1000 stocks
  const maxStocks = Math.min(totalFound || 1000, MAX_PAGES * PAGE_SIZE);

  while (offset < maxStocks) {
    if (offset > 0) {
      await navigateAndWait(page, screenerUrl(offset, exchange), 2000);
    }

    const stocks = await page.evaluate(() => {
      const rows = [];
      // The screener table has class "screener_table" or is inside the screener content
      const allTables = document.querySelectorAll('table');
      for (const table of allTables) {
        const trs = table.querySelectorAll('tr');
        for (const tr of trs) {
          const tds = Array.from(tr.querySelectorAll('td'));
          if (tds.length >= 10) {
            const text = tds.map((td) => td.textContent.trim());
            // Screener overview columns: No, Ticker, Company, Sector, Industry, Country, Market Cap, P/E, Price, Change, Volume
            const tickerLink = tds[1]?.querySelector('a');
            if (tickerLink && /^[A-Z.]{1,6}$/.test(text[1])) {
              rows.push({
                no: text[0],
                ticker: text[1],
                company: text[2],
                sector: text[3],
                industry: text[4],
                country: text[5],
                marketCap: text[6],
                pe: text[7],
                price: text[8],
                change: text[9],
                volume: text[10] || '',
              });
            }
          }
        }
      }
      return rows;
    });

    if (stocks.length === 0) {
      console.error(`No stocks found on page at offset ${offset}, stopping.`);
      break;
    }

    allStocks.push(...stocks);
    console.error(`Page ${offset / PAGE_SIZE + 1}: ${stocks.length} stocks (total: ${allStocks.length})`);
    offset += PAGE_SIZE;

    // Rate limiting
    await new Promise((r) => setTimeout(r, 1500));
  }

  await browser.close();

  return allStocks;
}

async function scrapeStockDetail(browser, ticker) {
  const page = await newPage(browser);
  await navigateAndWait(page, `https://finviz.com/quote.ashx?t=${ticker}`, 2000);

  const detail = await page.evaluate(() => {
    const data = {};
    // The quote page has a table with key-value pairs
    const rows = document.querySelectorAll('table.snapshot-table2 tr, table.snapshot-table tr');
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));
      for (let i = 0; i < cells.length - 1; i += 2) {
        const key = cells[i]?.textContent.trim();
        const val = cells[i + 1]?.textContent.trim();
        if (key && val) data[key] = val;
      }
    }

    // Also try the snapshot table structure finviz uses
    const snapCells = document.querySelectorAll('td.snapshot-td2, td.snapshot-td');
    for (let i = 0; i < snapCells.length - 1; i += 2) {
      const key = snapCells[i]?.textContent.trim();
      const val = snapCells[i + 1]?.textContent.trim();
      if (key && val) data[key] = val;
    }

    return data;
  });

  await page.close();
  return detail;
}

(async () => {
  try {
    const stocks = await scrapeScreener(EXCHANGE);

    if (stocks.length === 0) {
      console.error('No stocks scraped.');
      process.exit(1);
    }

    ensureDir(OUTPUT_DIR);

    // Write screener data
    const exchLabel = EXCHANGE || 'all';
    const csvFile = path.join(OUTPUT_DIR, `stocks_${exchLabel}.csv`);
    const header = 'ticker,company,sector,industry,country,market_cap,pe,price,change,volume';
    const rows = stocks.map((s) =>
      [s.ticker, `"${s.company}"`, `"${s.sector}"`, `"${s.industry}"`, s.country, s.marketCap, s.pe, s.price, s.change, s.volume].join(',')
    );
    fs.writeFileSync(csvFile, [header, ...rows].join('\n'));
    console.error(`Wrote ${stocks.length} stocks to ${csvFile}`);
    console.log([header, ...rows].join('\n'));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
})();
