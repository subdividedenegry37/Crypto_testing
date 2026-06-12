#!/usr/bin/env node
"use strict";

/**
 * analyze.js — standalone summary of logs/events.ndjson
 *
 * Reads the bot's structured NDJSON event log and prints a clean summary over a
 * time window (default: the last 24 hours).
 *
 * IMPORTANT: every profit figure reported here is GROSS — pure price-difference
 * profitability, BEFORE gas and fees. The bot intentionally does not model gas/costs.
 *
 * Usage:
 *   node scripts/analyze.js                 # last 24h (wall-clock now - 24h .. now)
 *   node scripts/analyze.js 48              # last 48h
 *   node scripts/analyze.js --hours 6       # last 6h
 *   node scripts/analyze.js --all           # entire log, no time filter
 *   node scripts/analyze.js --file <path>   # analyze a different ndjson file
 */

const fs = require("fs");
const path = require("path");

// ----------------------------- arg parsing -----------------------------
function parseArgs(argv) {
  const opts = { hours: 24, all: false, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") opts.all = true;
    else if (a === "--hours") opts.hours = Number(argv[++i]);
    else if (a === "--file") opts.file = argv[++i];
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (/^\d+(\.\d+)?$/.test(a)) opts.hours = Number(a); // bare positional = hours
  }
  if (!Number.isFinite(opts.hours) || opts.hours <= 0) opts.hours = 24;
  return opts;
}

// ----------------------------- helpers -----------------------------
function fmtUsd(v) {
  if (v == null || !Number.isFinite(v)) return "null";
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(4)}`;
}

function median(sorted) {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function countBreakdown(items, keyFn) {
  const m = {};
  for (const it of items) {
    const k = keyFn(it);
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

function printBreakdown(title, map) {
  console.log(title);
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    console.log("    (none)");
    return;
  }
  for (const [k, v] of entries) console.log(`    ${String(k).padEnd(26)} ${v}`);
}

// ----------------------------- main -----------------------------
function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log("Usage: node scripts/analyze.js [hours | --hours N | --all] [--file <path>]");
    return;
  }

  const filePath = opts.file
    ? path.resolve(opts.file)
    : path.join(process.cwd(), "logs", "events.ndjson");

  if (!fs.existsSync(filePath)) {
    console.error(`Event log not found: ${filePath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);

  // Parse, tolerant of malformed lines.
  const all = [];
  let malformed = 0;
  for (const line of raw) {
    try {
      all.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }

  // Time window (wall-clock now anchor).
  const nowMs = Date.now();
  const startMs = opts.all ? -Infinity : nowMs - opts.hours * 3600 * 1000;
  const windowEndIso = new Date(nowMs).toISOString();
  const windowStartIso = opts.all ? "(beginning of log)" : new Date(startMs).toISOString();

  const events = all.filter((e) => {
    if (opts.all) return true;
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && t >= startMs && t <= nowMs;
  });

  // -------------------- header --------------------
  const bar = "═".repeat(72);
  console.log(bar);
  console.log("ARBITRAGE EVENT LOG ANALYSIS  —  all profit figures are GROSS (before gas)");
  console.log(bar);
  console.log(`Log file:        ${filePath}`);
  console.log(`Window:          ${opts.all ? "ALL TIME" : `last ${opts.hours}h`}`);
  console.log(`Window start:    ${windowStartIso}`);
  console.log(`Window end:      ${windowEndIso}`);
  if (malformed) console.log(`Malformed lines skipped: ${malformed}`);
  console.log("");

  if (events.length === 0) {
    console.log("No events in the selected window.");
    console.log(`(Total events in file: ${all.length})`);
    return;
  }

  // Actual data span inside the window.
  const tsList = events.map((e) => e.ts).filter(Boolean).sort();
  const firstTs = tsList[0];
  const lastTs = tsList[tsList.length - 1];
  const spanMs = Date.parse(lastTs) - Date.parse(firstTs);
  const spanHours = Number.isFinite(spanMs) ? (spanMs / 3600000).toFixed(2) : "n/a";

  console.log(`Total events in window:  ${events.length}   (of ${all.length} in file)`);
  console.log(`Data span in window:     ${firstTs}  ->  ${lastTs}  (${spanHours}h)`);
  console.log("");

  // -------------------- outcome breakdown --------------------
  printBreakdown("Outcome breakdown:", countBreakdown(events, (e) => e.outcome ?? "(unknown)"));
  console.log("");

  // -------------------- reject_reason breakdown --------------------
  printBreakdown(
    "Reject-reason breakdown:",
    countBreakdown(events, (e) => e.reject_reason ?? "(none)")
  );
  console.log("");

  // -------------------- per-pair counts --------------------
  printBreakdown("Per-pair counts:", countBreakdown(events, (e) => e.pair ?? "(unknown)"));
  console.log("");

  // -------------------- spread_bps distribution --------------------
  const spreads = events
    .map((e) => e.spread_bps)
    .filter((v) => v != null && Number.isFinite(Number(v)))
    .map(Number)
    .sort((a, b) => a - b);

  console.log("Spread (bps) distribution:");
  if (spreads.length === 0) {
    console.log("    (no events with a numeric spread_bps in window)");
  } else {
    const sum = spreads.reduce((a, b) => a + b, 0);
    const over50 = spreads.filter((v) => v > 50).length;
    const over100 = spreads.filter((v) => v > 100).length;
    console.log(`    samples: ${spreads.length}  (events with non-null spread_bps)`);
    console.log(`    min:     ${spreads[0]}`);
    console.log(`    median:  ${median(spreads)}`);
    console.log(`    mean:    ${(sum / spreads.length).toFixed(2)}`);
    console.log(`    max:     ${spreads[spreads.length - 1]}`);
    console.log(`    > 50 bps:  ${over50}`);
    console.log(`    > 100 bps: ${over100}`);
  }
  console.log("");

  // -------------------- events that reached the profit calc --------------------
  // "Reached the profit calc" = determineProfit ran => outcome evaluated or would_trade.
  const reached = events
    .filter((e) => e.outcome === "evaluated" || e.outcome === "would_trade")
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  console.log(bar);
  console.log(`EVENTS THAT REACHED THE PROFIT CALC: ${reached.length}   (GROSS profit, before gas)`);
  console.log(bar);
  if (reached.length === 0) {
    console.log("    (none reached determineProfit in this window)");
  } else {
    console.log(
      `    ${"timestamp".padEnd(26)} ${"pair".padEnd(11)} ${"outcome".padEnd(11)} ${"spread".padEnd(8)} gross_est_profit_usd`
    );
    for (const e of reached) {
      const usd = e.est_profit_usd == null ? null : Number(e.est_profit_usd);
      const note = e.est_profit_usd == null ? "  (null — pre-fix decimals bail)" : "";
      console.log(
        `    ${String(e.ts).padEnd(26)} ${String(e.pair).padEnd(11)} ${String(e.outcome).padEnd(11)} ${String(e.spread_bps ?? "-").padEnd(8)} ${fmtUsd(usd)}${note}`
      );
    }
  }
  console.log("");

  // -------------------- single best gross opportunity --------------------
  const numeric = reached
    .map((e) => ({ e, usd: e.est_profit_usd == null ? null : Number(e.est_profit_usd) }))
    .filter((x) => x.usd != null && Number.isFinite(x.usd));

  console.log(bar);
  console.log("SINGLE BEST GROSS OPPORTUNITY IN WINDOW (largest est_profit_usd, before gas)");
  console.log(bar);
  let best = null;
  if (numeric.length === 0) {
    console.log("    No event produced a numeric gross profit in this window.");
  } else {
    best = numeric.reduce((a, b) => (b.usd > a.usd ? b : a));
    const be = best.e;
    console.log(`    pair:               ${be.pair}`);
    console.log(`    timestamp:          ${be.ts}`);
    console.log(`    source_dex:         ${be.source_dex ?? "-"}`);
    console.log(`    spread_bps:         ${be.spread_bps ?? "-"}`);
    console.log(`    GROSS est_profit:   ${fmtUsd(best.usd)}  (USD, before gas)`);
    console.log(`    est_profit_weth:    ${be.est_profit_weth_raw ?? "null"} (raw wei)`);
    console.log(`    trade_size_raw:     ${be.trade_size_raw ?? "null"} (raw wei)`);
  }
  console.log("");

  // -------------------- verdict --------------------
  const positive = numeric.filter((x) => x.usd > 0).length;
  const bestUsd = numeric.length ? best.usd : null;
  console.log(bar);
  console.log(
    `VERDICT (GROSS, before gas): ${positive} of ${reached.length} profit-calc event(s) had POSITIVE gross profit; ` +
      `best gross seen = ${bestUsd == null ? "n/a (no numeric profit)" : fmtUsd(bestUsd)}` +
      `${best ? ` on ${best.e.pair} @ ${best.e.ts}` : ""}.`
  );
  console.log(bar);
}

main();
