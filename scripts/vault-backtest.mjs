#!/usr/bin/env node

// Usage: node scripts/vault-backtest.mjs --dataset <file.json> [--target-delta 0.3] [--fee-bps 0]
//        [--rate 0] [--assignment deliver|rebuy] [--out <file.json>]
// Output is deterministic JSON for a given dataset file and options.

import fs from 'fs';
import { runBacktest } from './vault-backtest/simulate.mjs';

const FLAGS = {
  '--dataset': 'dataset',
  '--target-delta': 'targetDelta',
  '--fee-bps': 'feeBps',
  '--rate': 'rate',
  '--assignment': 'assignmentPolicy',
  '--out': 'out',
};

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = FLAGS[argv[i]];
    if (!key || argv[i + 1] === undefined) {
      throw new Error(`usage: node scripts/vault-backtest.mjs --dataset <file.json> [options]`);
    }
    opts[key] = argv[i + 1];
  }
  if (!opts.dataset) throw new Error('--dataset is required');
  return opts;
}

try {
  const { dataset: datasetPath, out, ...flags } = parseArgs(process.argv.slice(2));
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  const overrides = {};
  if (flags.targetDelta !== undefined) overrides.targetDelta = Number(flags.targetDelta);
  if (flags.feeBps !== undefined) overrides.feeBps = Number(flags.feeBps);
  if (flags.rate !== undefined) overrides.rate = Number(flags.rate);
  if (flags.assignmentPolicy !== undefined) overrides.assignmentPolicy = flags.assignmentPolicy;

  const result = `${JSON.stringify(runBacktest(dataset, overrides), null, 2)}\n`;
  if (out) {
    fs.writeFileSync(out, result);
  } else {
    process.stdout.write(result);
  }
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
