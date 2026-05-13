#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const command = args[0] || 'help';

const COMMANDS = {
  chart: {
    script: 'scrape.js',
    usage: 'finviz chart <TICKER> [timeframe] [output_dir]',
    desc: 'Scrape chart data for a stock ticker (OHLCV CSV)',
  },
  stocks: {
    script: 'scrape-stocks.js',
    usage: 'finviz stocks [exchange] [output_dir]',
    desc: 'Scrape stock listings with sector/industry (exchange: nyse, nasdaq, amex)',
  },
  futures: {
    script: 'scrape-futures.js',
    usage: 'finviz futures [output_dir]',
    desc: 'Scrape futures contracts with exchange info',
  },
  forex: {
    script: 'scrape-forex.js',
    usage: 'finviz forex [output_dir]',
    desc: 'Scrape forex pairs with rates',
  },
};

if (command === 'help' || !COMMANDS[command]) {
  console.log('finviz-chart-scraper — Extract financial data from finviz.com\n');
  console.log('Commands:');
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    console.log(`  ${cmd.usage}`);
    console.log(`    ${cmd.desc}\n`);
  }
  console.log('Examples:');
  console.log('  node cli.js chart AAPL d');
  console.log('  node cli.js stocks nyse');
  console.log('  node cli.js futures');
  console.log('  node cli.js forex');
  process.exit(command === 'help' ? 0 : 1);
}

const cmd = COMMANDS[command];
const scriptArgs = args.slice(1).join(' ');
const script = path.join(__dirname, cmd.script);

try {
  execSync(`node ${script} ${scriptArgs}`, { stdio: 'inherit' });
} catch (err) {
  process.exit(err.status || 1);
}
