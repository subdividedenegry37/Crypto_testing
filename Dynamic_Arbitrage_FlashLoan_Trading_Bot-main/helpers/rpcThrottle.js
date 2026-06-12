"use strict";

let limiterPromise;

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_ATTEMPTS = 5;

// ============================================================
// HARD BACKSTOPS — two independent caps, gated before every RPC call.
// ------------------------------------------------------------
// LESSON FROM THE OVERNIGHT BLOWOUT: a CU/s cap is only as trustworthy as the
// CU cost table it counts with. Our table under-priced eth_getLogs ~30x, so the
// "300 CU/s cap" was counting in the wrong units and never engaged while Alchemy
// metered ~600 CU/s.
//
// FIX: the PRIMARY backstop is now a CALL-RATE cap (MAX_CALLS_PER_SEC) — it is
// independent of any cost estimate, so it holds even if every per-call CU number
// is wrong. With eth_getLogs removed from the hot path, every remaining call is a
// cheap, well-bounded eth_call/eth_blockNumber, so a low call rate × a pessimistic
// per-call cost is still safely under the 500 CU/s cap. The CU/s cap is kept as a
// secondary guard with deliberately CONSERVATIVE (over-estimated) costs.
// ============================================================

const MAX_CALLS_PER_SEC = Number(process.env.RPC_MAX_CALLS_PER_SEC || 3); // PRIMARY, cost-independent
const MAX_CU_PER_SEC = Number(process.env.RPC_MAX_CU_PER_SEC || 250); // secondary

// --- call-rate token bucket ---
const CALL_CAP = Math.max(2, MAX_CALLS_PER_SEC);
let callTokens = CALL_CAP;
let lastCallRefill = Date.now();

// --- CU token bucket ---
const CU_CAP = MAX_CU_PER_SEC;
let cuTokens = CU_CAP;
let lastCuRefill = Date.now();

// Conservative (OVER-estimated) Alchemy CU costs, keyed by withRpcRetry label.
// eth_getLogs is priced deliberately high so that if it is ever reintroduced the
// CU cap throttles it hard — but it is no longer used by the mainnet poll.
const CU_COST = {
  getBlockNumber: 12,
  "pair.getReserves": 30,
  "factory.getPair": 30,
  "pair.token0": 30,
  "token.decimals": 30,
  "token.symbol": 30,
  "token.getCode": 30,
  "uniswap.queryFilter": 2000,
  "sushi.queryFilter": 2000,
  getTransaction: 20,
};
const DEFAULT_CU = 50; // conservative generic

function cuCostFor(label) {
  return CU_COST[label] != null ? CU_COST[label] : DEFAULT_CU;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function refillCalls() {
  const now = Date.now();
  const elapsed = (now - lastCallRefill) / 1000;
  if (elapsed > 0) {
    callTokens = Math.min(CALL_CAP, callTokens + elapsed * MAX_CALLS_PER_SEC);
    lastCallRefill = now;
  }
}
function refillCu() {
  const now = Date.now();
  const elapsed = (now - lastCuRefill) / 1000;
  if (elapsed > 0) {
    cuTokens = Math.min(CU_CAP, cuTokens + elapsed * MAX_CU_PER_SEC);
    lastCuRefill = now;
  }
}

// Block until BOTH a call slot and `cost` CU are available, then deduct both.
async function acquire(cost) {
  const needCu = Math.min(cost, CU_CAP);
  for (;;) {
    refillCalls();
    refillCu();
    if (callTokens >= 1 && cuTokens >= needCu) {
      callTokens -= 1;
      cuTokens -= needCu;
      return;
    }
    const waitCall = callTokens >= 1 ? 0 : ((1 - callTokens) / MAX_CALLS_PER_SEC) * 1000;
    const waitCu = cuTokens >= needCu ? 0 : ((needCu - cuTokens) / MAX_CU_PER_SEC) * 1000;
    await sleep(Math.max(5, Math.ceil(Math.max(waitCall, waitCu))));
  }
}

// ============================================================
// MEASUREMENT — calls/s is ACCURATE (a direct count); CU/s is an ESTIMATE and
// must be validated against the Alchemy dashboard, not trusted on its own.
// ============================================================
let totalCu = 0;
let totalCalls = 0;
const startedAt = Date.now();
let windowCu = 0;
let windowCalls = 0;
let windowStart = Date.now();

function recordCall(cost) {
  totalCu += cost;
  totalCalls += 1;
  windowCu += cost;
  windowCalls += 1;
}

function getRpcStats() {
  const now = Date.now();
  const elapsedSec = (now - startedAt) / 1000;
  const windowSec = (now - windowStart) / 1000;
  return {
    totalCu,
    totalCalls,
    elapsedSec,
    avgCallsPerSec: elapsedSec > 0 ? totalCalls / elapsedSec : 0,
    avgCuPerSec: elapsedSec > 0 ? totalCu / elapsedSec : 0,
    recentCallsPerSec: windowSec > 0 ? windowCalls / windowSec : 0,
    recentCuPerSec: windowSec > 0 ? windowCu / windowSec : 0,
    maxCallsPerSec: MAX_CALLS_PER_SEC,
    maxCuPerSec: MAX_CU_PER_SEC,
  };
}

// Periodic self-report (every 60s). Leads with calls/s (the trustworthy metric).
if (process.env.RPC_STATS_LOG !== "off") {
  const t = setInterval(() => {
    const s = getRpcStats();
    console.log(
      `📈 RPC budget: calls=${s.totalCalls} ` +
        `rate=${s.avgCallsPerSec.toFixed(2)}/s (recent60s=${s.recentCallsPerSec.toFixed(2)}/s, cap ${s.maxCallsPerSec}/s) | ` +
        `CU-EST avg=${s.avgCuPerSec.toFixed(1)}/s recent=${s.recentCuPerSec.toFixed(1)}/s ` +
        `(estimate only — verify on dashboard)`
    );
    windowCu = 0;
    windowCalls = 0;
    windowStart = Date.now();
  }, 60000);
  if (typeof t.unref === "function") t.unref();
}

function isRateLimitError(err) {
  const text = [
    err?.code,
    err?.shortMessage,
    err?.message,
    err?.error?.message,
    err?.payload?.error?.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    text.includes("429") ||
    text.includes("rate limit") ||
    text.includes("compute units per second") ||
    text.includes("throughput")
  );
}

async function withRpcRetry(label, fn, attempts = DEFAULT_ATTEMPTS) {
  const limit = await getLimiter();
  const cost = cuCostFor(label);

  return limit(async () => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      // Each attempt is a real RPC call → gate it through BOTH hard caps.
      await acquire(cost);
      recordCall(cost);

      try {
        return await fn();
      } catch (err) {
        if (!isRateLimitError(err) || attempt === attempts - 1) {
          throw err;
        }

        const baseDelay = 750 * 2 ** attempt;
        const jitter = Math.floor(Math.random() * 350);
        const delay = baseDelay + jitter;
        console.warn(`RPC throttled during ${label}; retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  });
}

async function getLimiter() {
  if (!limiterPromise) {
    limiterPromise = import("p-limit").then(({ default: pLimit }) =>
      pLimit(Number(process.env.RPC_READ_CONCURRENCY || DEFAULT_CONCURRENCY))
    );
  }

  return limiterPromise;
}

module.exports = { withRpcRetry, isRateLimitError, getRpcStats };
