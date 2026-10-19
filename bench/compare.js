#!/usr/bin/env node
/**
 * Compare two benchmark result files, or print one.
 *
 *   node bench/compare.js base.json head.json [--threshold 25] [--min-ms 0.5] [--md report.md]
 *   node bench/compare.js results.json
 *
 * Exits 1 when any metric is worse than the base by more than --threshold
 * percent. Latencies must also have moved by at least --min-ms, so a 0.05ms
 * query going to 0.07ms is not reported as a 40% regression. Exits 2 when the
 * two files were not produced from the same dataset, since the numbers would
 * not be comparable.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    threshold: { type: 'string', default: '25' },
    'min-ms': { type: 'string', default: '0.5' },
    md: { type: 'string' },
  },
});

const thresholdPct = Number(values.threshold);
const minMs = Number(values['min-ms']);
const load = (path) => JSON.parse(readFileSync(path, 'utf8'));
const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

function emit(markdown) {
  console.log(markdown);
  if (values.md) writeFileSync(values.md, `${markdown}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

function describe(meta) {
  return `${fmt(meta.events)} events, seed ${meta.seed}, Node ${meta.node}, ${meta.cpu} x${meta.cpuCount}`;
}

function judge(base, head) {
  if (!(base.value > 0)) return { delta: Number.NaN, status: 'n/a' };
  const delta = ((head.value - base.value) / base.value) * 100;
  const worse = head.better === 'lower' ? delta : -delta; // positive means worse
  const significant = head.unit !== 'ms' || Math.abs(head.value - base.value) >= minMs;
  if (worse > thresholdPct && significant) return { delta, status: 'regression' };
  if (worse < -thresholdPct && significant) return { delta, status: 'improved' };
  return { delta, status: 'ok' };
}

if (positionals.length === 1) {
  const result = load(positionals[0]);
  const lines = [
    '### Benchmark results',
    '',
    `_${describe(result.meta)}${result.meta.commit ? `, commit ${result.meta.commit}` : ''}_`,
    '',
    '| Metric | Value | p95 |',
    '| --- | ---: | ---: |',
  ];
  for (const [name, m] of Object.entries(result.metrics)) {
    lines.push(`| \`${name}\` | ${fmt(m.value)} ${m.unit} | ${m.p95 === undefined ? '' : `${fmt(m.p95)} ms`} |`);
  }
  emit(lines.join('\n'));
} else if (positionals.length === 2) {
  const base = load(positionals[0]);
  const head = load(positionals[1]);

  if (base.meta.events !== head.meta.events || base.meta.seed !== head.meta.seed) {
    console.error(
      `These runs are not comparable: base used ${base.meta.events} events (seed ${base.meta.seed}), ` +
        `head used ${head.meta.events} events (seed ${head.meta.seed}).`,
    );
    process.exit(2);
  }

  const names = [...new Set([...Object.keys(base.metrics), ...Object.keys(head.metrics)])];
  const regressions = [];
  const lines = [
    '### Benchmark comparison',
    '',
    `_${describe(head.meta)}. Regression threshold: ${thresholdPct}% (latencies must also move by at least ${minMs} ms)._`,
    '',
    `Base: \`${base.meta.commit ?? 'unknown'}\`, head: \`${head.meta.commit ?? 'unknown'}\``,
    '',
    '| Metric | Base | Head | Change | |',
    '| --- | ---: | ---: | ---: | :---: |',
  ];

  for (const name of names) {
    const b = base.metrics[name];
    const h = head.metrics[name];
    if (!b || !h) {
      lines.push(`| \`${name}\` | ${b ? `${fmt(b.value)} ${b.unit}` : '-'} | ${h ? `${fmt(h.value)} ${h.unit}` : '-'} | ${b ? 'removed' : 'new'} | |`);
      continue;
    }
    const { delta, status } = judge(b, h);
    const sign = delta > 0 ? '+' : '';
    const icon = status === 'regression' ? '🔺 regression' : status === 'improved' ? '✅ faster' : '';
    lines.push(
      `| \`${name}\` | ${fmt(b.value)} ${b.unit} | ${fmt(h.value)} ${h.unit} | ${Number.isNaN(delta) ? 'n/a' : `${sign}${delta.toFixed(1)}%`} | ${icon} |`,
    );
    if (status === 'regression') regressions.push({ name, base: b, head: h, delta });
  }

  lines.push('');
  lines.push(
    regressions.length === 0
      ? 'No significant regressions.'
      : `**${regressions.length} significant regression(s)** against the base commit.`,
  );
  emit(lines.join('\n'));

  for (const r of regressions) {
    const message = `${r.name}: ${fmt(r.base.value)} -> ${fmt(r.head.value)} ${r.head.unit} (${r.delta > 0 ? '+' : ''}${r.delta.toFixed(1)}%)`;
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=Performance regression::${message}`);
    else console.error(`REGRESSION ${message}`);
  }
  if (regressions.length > 0) process.exitCode = 1;
} else {
  console.error('usage: node bench/compare.js <base.json> <head.json> [--threshold 25] [--min-ms 0.5] [--md report.md]');
  console.error('       node bench/compare.js <results.json>');
  process.exitCode = 2;
}
