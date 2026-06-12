/**
 * ────────────────────────────────────────────────────────────────────────────────
 * Arbitrage Bot for Uniswap and Sushiswap
 * ────────────────────────────────────────────────────────────────────────────────
 *
 * Features:
 * - Monitors price differences between two tokens (e.g., WETH/SHIB) on Uniswap and Sushiswap
 * - Determines arbitrage direction and profitability
 * - Executes 2-token arbitrage (supports 3-token in future)
 * - Handles dummy token for 2-token trades
 * - Includes cooldown and safety mechanisms
 *
 * Notes:
 * - Fully BigInt compatible
 * - Compatible with Ethers v6
 */

"use strict";

require("./helpers/server");
require("dotenv").config();

const { ethers } = require("ethers");
const chalk = require("chalk");
const config = require("./config.json");
const { withRpcRetry } = require("./helpers/rpcThrottle");
const { logEvent } = require("./helpers/eventLog");

// Now destructure after the config is loaded
const { PROJECT_SETTINGS } = config;

const {
  determineNetwork,
  getSigner,
  getOrCreatePairContract,
  evaluateLiquidity,
  getReserves,
  getWethReserve,
  estimateMaxProfit,
  getFlashLoanSize,
} = require("./helpers/helpers");

const { provider, uFactory, sFactory, uRouter, sRouter, arbitrage } =
  require("./helpers/initialization");

const topTokens = require("./helpers/topTokens");
const REQUIRE_MEMPOOL_MATCH = true;
let lastMempoolEvent = Date.now();
let isResetting = false;

// Simulate orange color
const orange = chalk.rgb(255, 140, 0);

// ENV
const arbFor = process.env.ARB_FOR;       // e.g., WETH
const wethAddress = process.env.WETH;
const vaultAddress = process.env.VAULT_ADDRESS || ethers.ZeroAddress;

// Minimal ERC20 ABI
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// ─────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────
async function main() {
  // ============================================================
  // 1️⃣ ENVIRONMENT
  // ============================================================
  const isLocal = PROJECT_SETTINGS.isLocal;
  console.log(`Running in ${isLocal ? "LOCAL FORK" : "LIVE MAINNET"} mode`);

  // ============================================================
  // 2️⃣ PROVIDERS
  // ============================================================
  let executionProvider;
  let monitoringProvider;

  if (isLocal) {
    executionProvider = new ethers.JsonRpcProvider(
      process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545"
    );
    monitoringProvider = executionProvider;
  } else {
    executionProvider = new ethers.JsonRpcProvider(
      `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
    );

    // The mainnet hot path now polls over the HTTP provider (stateless), so this
    // WebSocket is only used by the preserved (inactive) subscription design. We
    // still guard it with EXPONENTIAL BACKOFF reconnect so a free-tier blip can
    // never become a tight reconnect loop.
    const WSS_URL = `wss://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
    let wsReconnectAttempts = 0;
    let wsReconnecting = false;
    const MAX_WS_BACKOFF_MS = 60000;

    const attachWsHandlers = (prov) => {
      try {
        prov.on("error", (err) => {
          console.error("WebSocket Error:", err?.message || err);
          scheduleWsReconnect();
        });
      } catch {}
    };

    const scheduleWsReconnect = () => {
      if (wsReconnecting) return; // never stack / never tight-loop
      wsReconnecting = true;
      const delay =
        Math.min(MAX_WS_BACKOFF_MS, 1000 * 2 ** wsReconnectAttempts) +
        Math.floor(Math.random() * 500);
      console.warn(
        `WS dropped; reconnecting in ${delay}ms (backoff attempt ${wsReconnectAttempts + 1})`
      );
      const timer = setTimeout(async () => {
        try { await monitoringProvider?.destroy?.(); } catch {}
        try {
          monitoringProvider = new ethers.WebSocketProvider(WSS_URL);
          attachWsHandlers(monitoringProvider);
          wsReconnectAttempts = 0; // success resets backoff
        } catch {
          wsReconnectAttempts = Math.min(wsReconnectAttempts + 1, 6);
        } finally {
          wsReconnecting = false;
        }
      }, delay);
      if (typeof timer.unref === "function") timer.unref();
    };

    monitoringProvider = new ethers.WebSocketProvider(WSS_URL);
    attachWsHandlers(monitoringProvider);
  }

  // Keep contract reads on the HTTP JSON-RPC provider. WebSocket is used only
  // for live Swap subscriptions so eth_call/getReserves stay on Alchemy HTTP.
  const readProvider = executionProvider;
  // ---- Free-tier CU budget (avg ~15-20 CU/s target; 500 CU/s & 30M CU/mo caps) ----
  // Background reserve refresh cadence. Slowed from 25s and the cache TTL raised to
  // match so the two background refresh loops (refreshPairs + updateLiquidity) share
  // one set of reserve reads per window instead of each re-fetching.
  const REFRESH_INTERVAL_MS = Number(process.env.REFRESH_INTERVAL_MS || 300000);
  const RESERVE_CACHE_TTL_MS = 290000;
  // Mainnet evaluation cadence (reserves-only interval polling; no eth_getLogs).
  const MAINNET_POLL_INTERVAL_MS = Number(process.env.MAINNET_POLL_INTERVAL_MS || 90000);

  // ============================================================
  // 3️⃣ MONITORING UI STATE
  // ============================================================
  let monitoringInterval;
  let monitoringPaused = false;
  let dots = 0;

  const startMonitoring = () => {
    if (monitoringInterval) return;

    monitoringInterval = setInterval(() => {
      if (!monitoringPaused) {
        dots = (dots + 1) % 7;
        process.stdout.write(`\r⏳ Monitoring${".".repeat(dots)}   `);
      }
    }, 500);
  };

  const pauseMonitoring = () => {
    monitoringPaused = true;
    process.stdout.write("\r                     \r");
  };

  const resumeMonitoring = () => {
    monitoringPaused = false;
    if (!monitoringInterval) startMonitoring();
  };

  // ============================================================
  // 4️⃣ NETWORK DETECTION
  // ============================================================
  const { type, startBlock } = await determineNetwork(
    executionProvider,
    null,
    isLocal
  );

  console.log(`Network type: ${type}`);
  const networkType = type;

  // ============================================================
  // 5️⃣ SIGNER + FLASH LOAN SIZE
  // ============================================================
  const signer = await getSigner(type, executionProvider);
  const FLASH_LOAN_SIZE = getFlashLoanSize(type);

  // ============================================================
  // 6️⃣ LOAD TOKENS
  // ============================================================
  let loadedTokens = 0;
  for (const token of topTokens) {
    try {
      token.address = ethers.getAddress(token.address.toLowerCase());
      token.contract = new ethers.Contract(
        token.address,
        ERC20_ABI,
        executionProvider
      );

      const code = await withRpcRetry("token.getCode", () =>
        executionProvider.getCode(token.address)
      );

      if (code !== "0x") {
        try {
          token.decimals = BigInt(await withRpcRetry("token.decimals", () =>
            token.contract.decimals()
          ));
        } catch {
          token.decimals = 18n;
        }

        try {
          token.symbol = await withRpcRetry("token.symbol", () =>
            token.contract.symbol()
          );
        } catch {}
      }

      loadedTokens++;
    } catch (err) {
      console.error(`Error loading token ${token.symbol}:`, err);
    }
  }

  console.log(`✅ Loaded ${loadedTokens} tokens`);

  const usdcToken = {
    address: process.env.USDC,
    symbol: "USDC",
    decimals: 6n
  };

  // ============================================================
  // 7️⃣ PAIR DISCOVERY (WITH CACHING AND LAST-PROCESSED BLOCKS)
  // ============================================================
  
  const discoveredPairsMap = new Map();
  const pairLiquidity = {};
  const reserveCache = new Map();          // cache reserves
  const routingCache = new Map();          // cache routing score
  const lastProcessedBlockPerPair = new Map(); // track last processed block

  const WETH = ethers.getAddress(process.env.WETH.toLowerCase());
  const USDC = ethers.getAddress(process.env.USDC.toLowerCase());
  const DAI  = ethers.getAddress(process.env.DAI.toLowerCase());
  const USDT = ethers.getAddress(process.env.USDT.toLowerCase());

  let bridgeFull = 0, bridgePartial = 0, bridgeMinimal = 0, bridgeNone = 0;

  const wethToken = topTokens.find(t => t.address.toLowerCase() === WETH.toLowerCase());
  if (!wethToken) throw new Error("❌ WETH not found in topTokens");

  // -----------------------------
  // 🔹 Refresh / Update Function (optimized)
  // -----------------------------
  const refreshPairs = async () => {
    bridgeFull = bridgePartial = bridgeMinimal = bridgeNone = 0; // reset bridge counters
    const now = Date.now();

    // Get all WETH pairs to refresh (existing discovered + new undiscovered)
    const wethPairsToUpdate = topTokens
      .filter(t => t.address.toLowerCase() !== WETH.toLowerCase())
      .map(token => ({ tokenA: token, tokenB: wethToken }));

    // Refresh each WETH pair
    await Promise.all(wethPairsToUpdate.map(async ({ tokenA, tokenB }) => {
      const pairKey = [tokenA.address, tokenB.address].sort().join("_");
      const existingPair = discoveredPairsMap.get(pairKey);

      try {
        const uPair = await getOrCreatePairContract(uFactory, tokenA.address, tokenB.address, monitoringProvider);
        const sPair = await getOrCreatePairContract(sFactory, tokenA.address, tokenB.address, monitoringProvider);
        if (!uPair && !sPair) return; // no pair exists

        const uReadPair = uPair ? uPair.connect(readProvider) : null;
        const sReadPair = sPair ? sPair.connect(readProvider) : null;

        // canonical token order
        const chainToken0 = uReadPair
          ? await withRpcRetry("pair.token0", () => uReadPair.token0())
          : await withRpcRetry("pair.token0", () => sReadPair.token0());
        let actualToken0 = tokenA, actualToken1 = tokenB;
        if (chainToken0.toLowerCase() === tokenB.address.toLowerCase()) {
          [actualToken0, actualToken1] = [tokenB, tokenA];
        }

        const uniExists = !!uPair;
        const sushiExists = !!sPair;
        const isOneSided = uniExists !== sushiExists;
        const isDirect = uniExists && sushiExists;

        // -----------------------------
        // Reserves / Liquidity
        let cachedReserves = reserveCache.get(pairKey);
        if (!cachedReserves || now - cachedReserves.lastUpdated > RESERVE_CACHE_TTL_MS) {
          const uRes = uPair ? await getReserves(uFactory, actualToken0, actualToken1, readProvider) : cachedReserves?.uReserves ?? null;
          const sRes = sPair ? await getReserves(sFactory, actualToken0, actualToken1, readProvider) : cachedReserves?.sReserves ?? null;
          cachedReserves = { uReserves: uRes, sReserves: sRes, lastUpdated: now };
          reserveCache.set(pairKey, cachedReserves);
        }

        const { uReserves, sReserves } = cachedReserves;
        const minTradeSize = 10n ** 16n;
        const minTokenReserve = 10n ** BigInt(actualToken0.decimals);

        const uLiquidityValid = uReserves
          ? evaluateLiquidity({ reserveBase: BigInt(uReserves.reserveA), minTradeSize, minTokenReserve, dexName: `Uniswap ${actualToken0.symbol}/${actualToken1.symbol}` }).valid
          : false;
        const sLiquidityValid = sReserves
          ? evaluateLiquidity({ reserveBase: BigInt(sReserves.reserveA), minTradeSize, minTokenReserve, dexName: `Sushi ${actualToken0.symbol}/${actualToken1.symbol}` }).valid
          : false;

        const canTrade = (uniExists && sushiExists) ? uLiquidityValid && sLiquidityValid : uLiquidityValid || sLiquidityValid;
        pairLiquidity[pairKey] = canTrade ? "OK" : "LOW";

        // -----------------------------
        // 🌉 Bridge coverage for one-sided WETH pairs
        // -----------------------------
        let bridgeCount = 0;
        let hasUSDC = false, hasDAI = false, hasUSDT = false;

        // Only check bridge tokens if the pair is one-sided
        if (isOneSided) {
          const nonWETHToken = actualToken0.address.toLowerCase() === WETH.toLowerCase() ? actualToken1 : actualToken0;

          const uPairUSDC = await getOrCreatePairContract(uFactory, nonWETHToken.address, USDC, readProvider);
          const sPairUSDC = await getOrCreatePairContract(sFactory, nonWETHToken.address, USDC, readProvider);
          const uPairDAI  = await getOrCreatePairContract(uFactory, nonWETHToken.address, DAI, readProvider);
          const sPairDAI  = await getOrCreatePairContract(sFactory, nonWETHToken.address, DAI, readProvider);
          const uPairUSDT = await getOrCreatePairContract(uFactory, nonWETHToken.address, USDT, readProvider);
          const sPairUSDT = await getOrCreatePairContract(sFactory, nonWETHToken.address, USDT, readProvider);

          hasUSDC = !!uPairUSDC || !!sPairUSDC;
          hasDAI  = !!uPairDAI  || !!sPairDAI;
          hasUSDT = !!uPairUSDT || !!sPairUSDT;

          bridgeCount = (hasUSDC ? 1 : 0) + (hasDAI ? 1 : 0) + (hasUSDT ? 1 : 0);
        }

        // Update global bridge counters
        if (bridgeCount === 3) bridgeFull++;
        else if (bridgeCount === 2) bridgePartial++;
        else if (bridgeCount === 1) bridgeMinimal++;
        else if (isOneSided) bridgeNone++;

        // -----------------------------
        // 🧠 ROUTING SCORE UPDATE (ENHANCED BUT SAFE)
        // -----------------------------

        let routingScore = 0;

        // -----------------------------
        // 🚨 HARD ELIGIBILITY GATE (UNCHANGED BEHAVIOR)
        // -----------------------------
        const isEligible =
          canTrade &&
          (!isOneSided || bridgeCount > 0);

        if (!isEligible) {
          routingScore = 0;
          pairLiquidity[pairKey] = "LOW";
        } else {

          // -----------------------------
          // base liquidity signal
          // -----------------------------
          let liquidityScore = canTrade ? 20 : 0;

          if (isOneSided) {
            liquidityScore = Math.floor(liquidityScore * 0.5);
          }

          // -----------------------------
          // dex coverage signal
          // -----------------------------
          let coverageScore = 0;

          if (uniExists && sushiExists) coverageScore = 15;
          else if (uniExists || sushiExists) coverageScore = 7;

          // -----------------------------
          // bridge signal
          // -----------------------------
          const bridgeScore = isOneSided
            ? Math.min(bridgeCount, 3)
            : 6;

          // =====================================================
          // 🔥 NEW ADDITIONS (SAFE NON-BREAKING ENHANCEMENTS)
          // =====================================================

          // -----------------------------
          // 1. Liquidity depth quality
          // -----------------------------
          const sharedLiquidity = canTrade
            ? (uReserves?.reserve0 && sReserves?.reserve0
                ? (BigInt(
                    uReserves.reserve0 < uReserves.reserve1
                      ? uReserves.reserve0
                      : uReserves.reserve1
                  ) <
                  BigInt(
                    sReserves.reserve0 < sReserves.reserve1
                      ? sReserves.reserve0
                      : sReserves.reserve1
                  )
                    ? BigInt(
                        uReserves.reserve0 < uReserves.reserve1
                          ? uReserves.reserve0
                          : uReserves.reserve1
                      )
                    : BigInt(
                        sReserves.reserve0 < sReserves.reserve1
                          ? sReserves.reserve0
                          : sReserves.reserve1
                      ))
                : 0n)
            : 0n;

          const depthScore = canTrade
            ? Math.min(15, Number(sharedLiquidity / 10n ** 16n))
            : 0;

          // -----------------------------
          // 2. Reserve balance quality
          // -----------------------------
          let balanceScore = 0;

          if (uReserves && sReserves) {
            const uMin =
              uReserves.reserve0 < uReserves.reserve1
                ? uReserves.reserve0
                : uReserves.reserve1;

            const uMax =
              uReserves.reserve0 > uReserves.reserve1
                ? uReserves.reserve0
                : uReserves.reserve1;

            const sMin =
              sReserves.reserve0 < sReserves.reserve1
                ? sReserves.reserve0
                : sReserves.reserve1;

            const sMax =
              sReserves.reserve0 > sReserves.reserve1
                ? sReserves.reserve0
                : sReserves.reserve1;

            const uRatio = uMax > 0n ? Number((uMin * 100n) / uMax) : 0;
            const sRatio = sMax > 0n ? Number((sMin * 100n) / sMax) : 0;

            balanceScore = Math.floor((uRatio + sRatio) / 8);
          }

          // -----------------------------
          // 3. Stability bonus
          // -----------------------------
          let stableLike = 0;

          if (hasUSDC && hasUSDT && hasDAI) stableLike = 10;
          else if (hasUSDC || hasUSDT || hasDAI) stableLike = 5;

          // -----------------------------
          // RAW SCORE (NO ARTIFICIAL NORMALIZATION YET)
          // -----------------------------
          const rawScore =
            liquidityScore +
            coverageScore +
            bridgeScore +
            depthScore +
            balanceScore +
            stableLike;

          // -----------------------------
          // FINAL NORMALIZATION (FIXED SCALE)
          // -----------------------------

          // instead of compressing everything, we clamp only
          routingScore = Math.min(30, Math.floor(rawScore * 0.5));
        }

        // -----------------------------
        // Update discoveredPairs
        const pairObj = {
            pairName: `${actualToken0.symbol}/${actualToken1.symbol}`,
            token0: actualToken0,
            token1: actualToken1,
            uPair,
            sPair,
            uniExists,
            sushiExists,
            isOneSided,
            isDirect,
            hasUSDC,
            hasDAI,
            hasUSDT,
            bridgeCount,
            routingScore,
            liquiditySnapshot: {
                canTrade,
                uLiquidityValid,
                sLiquidityValid,
                uReserve: uReserves?.reserveA ?? null,
                sReserve: sReserves?.reserveA ?? null
            }
        };

        
        if (!existingPair) {
          discoveredPairsMap.set(pairKey, pairObj);
        } else {
          Object.assign(existingPair, pairObj);
        }

        lastProcessedBlockPerPair.set(pairKey, startBlock);

        } catch (err) {
          console.warn(`Pair error ${tokenA.symbol}/${tokenB.symbol}:`, err.message);
        }
      }));
    };

  // -----------------------------
  // 🔄 Start periodic refresh at a low rate for Alchemy free-tier CU/s limits
  // -----------------------------

  const getDiscoveredPairs = () => [...discoveredPairsMap.values()];

  setInterval(async () => {
    try {
      await refreshPairs();
    } catch (err) {
      console.error("refreshPairs error:", err);
    }
  }, REFRESH_INTERVAL_MS);

  await refreshPairs(); // initial refresh

  // ✅ Keep one-sided map for swaps or other logic
  const oneSidedPairsMap = {};

  for (const p of getDiscoveredPairs()) {
    if (p.isOneSided) {
      const pairKey = [p.token0.address, p.token1.address]
        .sort()
        .join("_");

      oneSidedPairsMap[pairKey] = true;
    }
  }

  // -----------------------------
  // 🔄 PERIODIC LIQUIDITY UPDATE
  // -----------------------------

  let updatingLiquidity = false;

  const updateLiquidity = async () => {
    if (updatingLiquidity) return;

    updatingLiquidity = true;

    try {
      for (const p of getDiscoveredPairs()) {
        const { token0, token1, uPair, sPair } = p;

        if (!uPair && !sPair) continue;

        const pairKey = [token0.address, token1.address]
          .sort()
          .join("_");

        try {
          const cachedReserves = reserveCache.get(pairKey);

          if (
            !cachedReserves ||
            Date.now() - cachedReserves.lastUpdated > RESERVE_CACHE_TTL_MS
          ) {
            const uRes = uPair
              ? await getReserves(
                  uFactory,
                  token0,
                  token1,
                  readProvider
                )
              : null;

            const sRes = sPair
              ? await getReserves(
                  sFactory,
                  token0,
                  token1,
                  readProvider
                )
              : null;

            reserveCache.set(pairKey, {
              uReserves: uRes,
              sReserves: sRes,
              lastUpdated: Date.now()
            });
          }

          const { uReserves, sReserves } =
            reserveCache.get(pairKey);

          const maxReserve =
            BigInt(uReserves?.reserveA || 0n) >
            BigInt(sReserves?.reserveA || 0n)
              ? BigInt(uReserves?.reserveA || 0n)
              : BigInt(sReserves?.reserveA || 0n);

          const liquidityValid = evaluateLiquidity({
            reserveBase: maxReserve,
            minTradeSize: 10n ** 16n,
            minTokenReserve: 10n ** token0.decimals,
            dexName: `${token0.symbol}/${token1.symbol}`
          }).valid;

          pairLiquidity[pairKey] =
            liquidityValid ? "OK" : "LOW";

        } catch (err) {
          console.warn(
            `Failed to update liquidity for ${token0.symbol}/${token1.symbol}:`,
            err.message
          );
        }
      }
    } finally {
      updatingLiquidity = false;
    }
  };

  setInterval(async () => {
    try {
      await updateLiquidity();
    } catch (err) {
      console.error("updateLiquidity error:", err);
    }
  }, REFRESH_INTERVAL_MS);

  // -----------------------------
  // 🖨️ OUTPUT
  // -----------------------------

  const oneSidedPairs = getDiscoveredPairs().filter(
    p => p.isOneSided
  );

  const bothPairs = getDiscoveredPairs().filter(
    p => p.isDirect
  );

  console.log("\n📊 PAIR VERIFICATION:\n");

  console.log(
    `🔥 ONE-SIDED PAIRS (${oneSidedPairs.length}):\n`
  );

  if (!oneSidedPairs.length) {
    console.log("   None found");
  } else {
    for (const p of oneSidedPairs) {
      console.log(
        `🔥 ${p.pairName} (${p.uniExists ? "Uniswap only" : "Sushi only"})`
      );
    }
  }

  console.log(
    `\n✅ BOTH-SIDED PAIRS (${bothPairs.length}):\n`
  );

  for (const p of bothPairs) {
    const pairKey = [p.token0.address, p.token1.address]
      .sort()
      .join("_");

    console.log(
      `✅ ${p.pairName} (Uniswap + Sushi) | Liquidity: ${pairLiquidity[pairKey]}`
    );
  }

  console.log(`\n🌉 STABLE BRIDGE COVERAGE:`);
  console.log(`🟢 FULL (USDC + DAI + USDT): ${bridgeFull}`);
  console.log(`🟡 PARTIAL (2/3): ${bridgePartial}`);
  console.log(`🟠 MINIMAL (1/3): ${bridgeMinimal}`);
  console.log(`⚪ NONE: ${bridgeNone}`);

  console.log("\n🧠 ROUTING SCORES:");

  const printedPairs = new Set();

  for (const p of getDiscoveredPairs()) {
    const pairKey = [
      p.token0.address,
      p.token1.address
    ]
      .sort()
      .join("_");

    if (printedPairs.has(pairKey)) continue;

    printedPairs.add(pairKey);

    console.log(
      `${p.pairName}: ${p.routingScore}/30 | Liquidity: ${
        pairLiquidity[pairKey] === "OK"
          ? "✅"
          : "⚠"
      }`
    );
  }

  startMonitoring();

  // ============================================================
  // 8️⃣ SHARED STATE + 9️⃣ SWAP EVENT WRAPPER
  // ============================================================

  const processedTxHashes = new Set();
  const skippedFirstEventPerPair = {};
  const lastTradePerPair = {};
  const lastExecutionTimePerPair = {};
  const isExecutingTradePerPair = {};

  const refs = {
    signer,
    lastSubmittedTxHash: null,
    goodTradesCounter: 0
  };

  const buildSwapCall = (
    exchange,
    event,
    token0,
    token1,
    savedRoutingScore
  ) =>
    swapEvent({
      exchange,
      event,
      token0,
      token1,
      routingScore: savedRoutingScore,
      monitoringProvider: readProvider,
      topTokens,
      startBlock,
      processedTxHashes,
      skippedFirstEventPerPair,
      lastTradePerPair,
      lastExecutionTimePerPair,
      isExecutingTradePerPair,
      pauseMonitoring,
      resumeMonitoring,
      determineDirection,
      determineProfit,
      executeTrade,
      uFactory,
      sFactory,
      uRouter,
      sRouter,
      usdcToken,
      FLASH_LOAN_SIZE,
      networkType,
      executionProvider,
      refs,
      pairLiquidityMap: pairLiquidity,
      oneSidedPairsMap,
      reserveCache
    });

  // dynamic pair getter
  const getPairs = () => getDiscoveredPairs();

  // ============================================================
  // 🔟 EVENT MODE (POLLING OPTIMIZED / WEBSOCKET SAFE)
  // ============================================================
  if (isLocal || type === "FORK") {
    console.log("⚠️ Polling mode (local/fork)");

    setInterval(async () => {
      const currentBlock = await withRpcRetry("getBlockNumber", () =>
        executionProvider.getBlockNumber()
      );

      for (const pair of getPairs()) {
        const token0 = pair.token0;
        const token1 = pair.token1;
        const uPair = pair.uPair;
        const sPair = pair.sPair;

        // SAVE STABLE ROUTING SCORE
        const savedRoutingScore = BigInt(pair.routingScore);

        const pairKey = [token0.address, token1.address].sort().join("_");
        const lastBlock = lastProcessedBlockPerPair.get(pairKey) || (currentBlock - 10);

        // -----------------------------
        // Poll Uniswap logs
        if (uPair) {
          const logs = await withRpcRetry("uniswap.queryFilter", () =>
            uPair.queryFilter(
              uPair.filters.Swap(),
              lastBlock + 1,
              currentBlock
            )
          );

          for (const log of logs) {
            await buildSwapCall(
              "Uniswap",
              log,
              token0,
              token1,
              savedRoutingScore
            );
          }
        }

        // -----------------------------
        // Poll Sushi logs
        if (sPair) {
          const logs = await withRpcRetry("sushi.queryFilter", () =>
            sPair.queryFilter(
              sPair.filters.Swap(),
              lastBlock + 1,
              currentBlock
            )
          );

          for (const log of logs) {
            await buildSwapCall(
              "Sushi",
              log,
              token0,
              token1,
              savedRoutingScore
            );
          }
        }

        lastProcessedBlockPerPair.set(pairKey, currentBlock);
      }
    }, 1000);

  } else {
    // ============================================================
    // ✅ MAINNET: INTERVAL POLLING v2 (call-rate-budgeted, NO eth_getLogs)
    // ------------------------------------------------------------
    // v1 polled via queryFilter (eth_getLogs), whose REAL Alchemy CU cost is high
    // and scales with how many swaps sit in the lookback window. Our cost table
    // under-priced it ~30x, so both the CU estimate AND the CU-based limiter were
    // blind, and the bot metered ~600 CU/s overnight while self-reporting ~18.
    //
    // v2 makes ZERO eth_getLogs calls. Each cycle it evaluates every pair directly
    // off reserves: determineDirection (eventAmountIn = 0 → spread on the CURRENT
    // reserves) + determineProfit — reusing the unchanged strategy math and the
    // same NDJSON schema. Every RPC call is now a cheap, well-bounded eth_call /
    // eth_blockNumber, and the global CALL-RATE cap (rpcThrottle) bounds usage
    // INDEPENDENTLY of any (untrustworthy) CU estimate.
    // ============================================================
    console.log(
      "✅ Polling mode (mainnet, reserves-only, no getLogs) — every " +
        `${Math.round(MAINNET_POLL_INTERVAL_MS / 1000)}s`
    );

    // --- Preserved (INACTIVE) WebSocket subscription design — NOT invoked on mainnet ---
    const setupWebsocketSubscriptions = () => {
      for (const pair of getDiscoveredPairs()) {
        const token0 = pair.token0;
        const token1 = pair.token1;
        const uPair = pair.uPair;
        const sPair = pair.sPair;
        const savedRoutingScore = BigInt(pair.routingScore);

        if (uPair) {
          uPair.on(uPair.filters.Swap(), (...args) =>
            buildSwapCall("Uniswap", args[args.length - 1], token0, token1, savedRoutingScore)
          );
        }
        if (sPair) {
          sPair.on(sPair.filters.Swap(), (...args) =>
            buildSwapCall("Sushi", args[args.length - 1], token0, token1, savedRoutingScore)
          );
        }
      }
    };
    void setupWebsocketSubscriptions; // intentionally NOT invoked — polling is the active path

    const wethToken = topTokens.find((t) => t.symbol === "WETH");

    // Evaluate ONE pair off CURRENT reserves. Reuses determineDirection +
    // determineProfit (unchanged) and emits the same event schema. No eth_getLogs.
    const evaluatePairOnce = async (pair, blockNumber) => {
      const token0 = pair.token0;
      const token1 = pair.token1;
      if (!wethToken) return;

      const targetToken = token0.symbol === "WETH" ? token1 : token0;
      if (!targetToken || targetToken.symbol === "WETH") return; // not a WETH pair
      const inputToken = wethToken; // base = WETH (direction is moot at amountIn = 0)
      const outputToken = targetToken;

      const eventLogRecord = {
        schema_version: 1,
        ts: new Date().toISOString(),
        block: blockNumber ?? null,
        source_dex: "poll",
        pair: `${targetToken.symbol}/${wethToken.symbol}`,
        input_symbol: inputToken.symbol,
        output_symbol: outputToken.symbol,
        input_address: inputToken.address,
        output_address: outputToken.address,
        amount_in_raw: "0", // polled snapshot — no triggering swap
        uni_reserve_base_raw: null,
        uni_reserve_target_raw: null,
        sushi_reserve_base_raw: null,
        sushi_reserve_target_raw: null,
        spread_bps: null,
        impact_signal: null,
        liquidity_passed: null,
        spread_passed: null,
        outcome: null,
        reject_reason: null,
        est_profit_weth_raw: null,
        est_profit_usd: null,
        trade_size_raw: null
      };
      let emitted = false;
      const emit = (updates) => {
        if (emitted) return;
        emitted = true;
        logEvent({ ...eventLogRecord, ...updates });
      };

      try {
        const directionLogContext = {};
        const direction = await determineDirection(
          "Uniswap",
          inputToken,
          outputToken,
          usdcToken,
          0n, // eventAmountIn = 0 → spread on CURRENT reserves (no swap perturbation)
          uFactory,
          sFactory,
          uRouter,
          sRouter,
          readProvider,
          topTokens,
          pairLiquidity,
          oneSidedPairsMap,
          undefined,
          undefined,
          null,
          null,
          directionLogContext
        );

        Object.assign(eventLogRecord, directionLogContext);

        if (!direction) {
          const rejectReason =
            directionLogContext.liquidity_passed === false
              ? "shallow_pool"
              : directionLogContext.spread_passed === false
                ? "spread_below_threshold"
                : "direction_unavailable";
          emit({ outcome: "skipped", reject_reason: rejectReason });
          return;
        }

        const avgWethPrice = (direction.uniWethPriceUSDC + direction.sushiWethPriceUSDC) / 2;
        const arbResult = await determineProfit({
          baseToken: direction.baseToken,
          targetToken: direction.targetToken,
          routerPath: direction.routerPath,
          routerNames: direction.routerNames,
          startingReserves: direction.startingReserves,
          endingReserves: direction.endingReserves,
          eventAmountIn: FLASH_LOAN_SIZE,
          networkType,
          wethPriceInUSDC: avgWethPrice,
          provider: executionProvider,
          uniWethPerTokenEnd: direction.uniWethPerTokenEnd,
          sushiWethPerTokenEnd: direction.sushiWethPerTokenEnd
        });

        const estProfitWethRaw = arbResult?.profitWETH ?? arbResult?.profit ?? null;
        const estProfitUsd = arbResult?.profitUsd ?? arbResult?.profitUSDC ?? null;
        const tradeSizeRaw = arbResult?.tradeAmount ?? null;

        if (!arbResult?.profitable || (arbResult.tradeAmount ?? 0n) <= 0n) {
          emit({
            outcome: "evaluated",
            reject_reason: "below_min_profit",
            est_profit_weth_raw: estProfitWethRaw,
            est_profit_usd: estProfitUsd,
            trade_size_raw: tradeSizeRaw
          });
          return;
        }

        // SIMULATE only — record the opportunity; no executeTrade (SIMULATE_TRADES stays true).
        emit({
          outcome: "would_trade",
          reject_reason: null,
          est_profit_weth_raw: estProfitWethRaw,
          est_profit_usd: estProfitUsd,
          trade_size_raw: tradeSizeRaw
        });
      } catch (err) {
        emit({ outcome: "skipped", reject_reason: "processing_error" });
        console.warn(`poll eval ${targetToken?.symbol}/WETH skipped:`, err.message);
      }
    };

    // --- Active mainnet path: interval polling, reserves-only, no getLogs ---
    let pollInFlight = false;
    const runPollCycle = async () => {
      if (pollInFlight) return; // never overlap cycles
      pollInFlight = true;
      try {
        let blockNumber = null;
        try {
          blockNumber = await withRpcRetry("getBlockNumber", () => readProvider.getBlockNumber());
        } catch {
          blockNumber = null; // block is informational — continue without it
        }
        for (const pair of getDiscoveredPairs()) {
          await evaluatePairOnce(pair, blockNumber); // each call is internally try/caught
        }
      } catch (cycleErr) {
        console.warn("poll cycle skipped:", cycleErr.message);
      } finally {
        pollInFlight = false;
      }
    };

    runPollCycle(); // immediate first cycle
    setInterval(runPollCycle, MAINNET_POLL_INTERVAL_MS);
  }
}

// ─────────────────────────────────────────
// SWAP HANDLER (REFACTORED PROPERLY)
// ─────────────────────────────────────────
async function swapEvent(params) {
  const {
    exchange,
    event,
    token0,
    token1,
    routingScore,
    monitoringProvider,
    topTokens,
    startBlock,
    processedTxHashes,
    skippedFirstEventPerPair,
    lastTradePerPair,
    lastExecutionTimePerPair,
    isExecutingTradePerPair,
    pauseMonitoring,
    resumeMonitoring,
    determineDirection,
    determineProfit,
    executeTrade,
    uFactory,
    sFactory,
    uRouter,
    sRouter,
    usdcToken,
    FLASH_LOAN_SIZE,
    networkType,
    executionProvider,
    refs,
    pairLiquidityMap,
    oneSidedPairsMap,
    reserveCache
  } = params;

  // ============================================================
  // 🔹 INTERNAL QUEUE (SCOPED TO FUNCTION SYSTEM)
  // ============================================================

  if (!refs._swapQueue) refs._swapQueue = [];
  if (refs._isProcessingSwapQueue === undefined) refs._isProcessingSwapQueue = false;

  refs._swapQueue.push(params);

  // ============================================================
  // 🔹 QUEUE DRAINER (RUNS INLINE, NO OUTSIDE FUNCTIONS)
  // ============================================================

  if (refs._isProcessingSwapQueue) return;
  refs._isProcessingSwapQueue = true;

  const ORANGE = "\x1b[38;5;208m";
  const RESET = "\x1b[0m";

  try {
    while (refs._swapQueue.length > 0) {
      const p = refs._swapQueue.shift();
      if (!p) continue;

      let monitoringPaused = false;
      let eventLogRecord = null;
      let eventLogEmitted = false;

      const updateEventLog = (updates) => {
        if (eventLogRecord) Object.assign(eventLogRecord, updates);
      };

      const emitEventLog = (updates = {}) => {
        if (!eventLogRecord || eventLogEmitted) return;
        eventLogEmitted = true;
        logEvent({ ...eventLogRecord, ...updates });
      };

      try {
        const {
          exchange,
          event,
          token0,
          token1,
          routingScore,
          monitoringProvider,
          topTokens,
          startBlock,
          processedTxHashes,
          skippedFirstEventPerPair,
          lastTradePerPair,
          lastExecutionTimePerPair,
          isExecutingTradePerPair,
          pauseMonitoring,
          resumeMonitoring,
          determineDirection,
          determineProfit,
          executeTrade,
          uFactory,
          sFactory,
          uRouter,
          sRouter,
          usdcToken,
          FLASH_LOAN_SIZE,
          networkType,
          executionProvider,
          refs,
          pairLiquidityMap,
          oneSidedPairsMap,
          reserveCache
        } = p;

        const txHash = event.log?.transactionHash || event.transactionHash;
        if (!txHash) continue;

        if (processedTxHashes.has(txHash)) continue;
        processedTxHashes.add(txHash);

        if (processedTxHashes.size > 50000) {
          const first = processedTxHashes.values().next().value;
          processedTxHashes.delete(first);
        }

        const blockNumber =
          event.log?.blockNumber ||
          event.blockNumber ||
          (await withRpcRetry("getBlockNumber", () => monitoringProvider.getBlockNumber()));

        if (blockNumber <= startBlock) continue;

        // ============================================================
        // TOKEN DIRECTION
        // ============================================================

        let amountIn, rawInput, rawOutput;

        if (event.args.amount0In > 0n) {
          amountIn = event.args.amount0In;
          rawInput = token0;
          rawOutput = token1;
        } else if (event.args.amount1In > 0n) {
          amountIn = event.args.amount1In;
          rawInput = token1;
          rawOutput = token0;
        } else {
          continue;
        }

        const inputToken = topTokens.find(
          t => t.address.toLowerCase() === rawInput.address.toLowerCase()
        );

        const outputToken = topTokens.find(
          t => t.address.toLowerCase() === rawOutput.address.toLowerCase()
        );

        if (!inputToken || !outputToken) continue;

        const pairKey = [inputToken.address, outputToken.address].sort().join("_");

        // ============================================================
        // PER-PAIR LOCKS (UNCHANGED)
        // ============================================================

        if (!skippedFirstEventPerPair[pairKey]) {
          skippedFirstEventPerPair[pairKey] = true;
          continue;
        }

        if (isExecutingTradePerPair[pairKey]) continue;

        const now = Date.now();
        if (now - (lastExecutionTimePerPair[pairKey] || 0) < 3000) continue;

        if (lastTradePerPair[pairKey] === blockNumber) continue;

        const isWethPair =
          inputToken.symbol === "WETH" || outputToken.symbol === "WETH";

        if (!isWethPair) continue;

        const baseToken = topTokens.find(t => t.symbol === "WETH");
        const targetToken = inputToken.symbol === "WETH" ? outputToken : inputToken;
        if (!baseToken || !targetToken) continue;

        // ============================================================
        // OUTPUT (UNCHANGED)
        // ============================================================

        pauseMonitoring();
        monitoringPaused = true;

        eventLogRecord = {
          schema_version: 1,
          ts: new Date().toISOString(),
          block: blockNumber ?? null,
          source_dex: exchange ?? null,
          pair: `${targetToken.symbol}/${baseToken.symbol}`,
          input_symbol: inputToken.symbol,
          output_symbol: outputToken.symbol,
          input_address: inputToken.address,
          output_address: outputToken.address,
          amount_in_raw: amountIn.toString(),
          uni_reserve_base_raw: null,
          uni_reserve_target_raw: null,
          sushi_reserve_base_raw: null,
          sushi_reserve_target_raw: null,
          spread_bps: null,
          impact_signal: null,
          liquidity_passed: null,
          spread_passed: null,
          outcome: null,
          reject_reason: null,
          est_profit_weth_raw: null,
          est_profit_usd: null,
          trade_size_raw: null
        };

        console.log(ORANGE + "═══════════════════════════════════════════════════════════" + RESET);
        console.log(`\n📢 Swap Event Detected: ${inputToken.symbol} → ${outputToken.symbol}`);
        console.log(`Event Amount In: ${amountIn.toString()}`);

        const MIN_ROUTING_SCORE = 20n;

        if (routingScore < MIN_ROUTING_SCORE) {
          console.log(`❌ Skipping due to routing score: ${routingScore}`);
          emitEventLog({
            outcome: "skipped",
            reject_reason: "low_routing_score"
          });
          continue;
        }

        console.log(`✅ Using ${inputToken.symbol}/${outputToken.symbol} with routing score: ${routingScore}`);

        // ============================================================
        // RESERVES
        // ============================================================

        const cached = reserveCache.get(pairKey);
        if (!cached) {
          emitEventLog({ outcome: "skipped", reject_reason: "missing_reserves" });
          continue;
        }

        const uRes = cached.uReserves ?? null;
        const sRes = cached.sReserves ?? null;
        if (!uRes || !sRes) {
          emitEventLog({ outcome: "skipped", reject_reason: "missing_reserves" });
          continue;
        }

        const align = (res, inTok, outTok) => {
          const t0 = (res.token0 ?? "").toLowerCase();
          const t1 = (res.token1 ?? "").toLowerCase();

          const inA = inTok.address.toLowerCase();
          const outA = outTok.address.toLowerCase();

          const r0 = BigInt(res.reserve0 ?? 0n);
          const r1 = BigInt(res.reserve1 ?? 0n);

          if (inA === t0 && outA === t1) return { reserveIn: r0, reserveOut: r1 };
          if (inA === t1 && outA === t0) return { reserveIn: r1, reserveOut: r0 };

          return null;
        };

        const alignBaseTarget = (res, baseTok, targetTok) => {
          const t0 = (res.token0 ?? "").toLowerCase();
          const t1 = (res.token1 ?? "").toLowerCase();

          const baseA = baseTok.address.toLowerCase();
          const targetA = targetTok.address.toLowerCase();

          const r0 = BigInt(res.reserve0 ?? 0n);
          const r1 = BigInt(res.reserve1 ?? 0n);

          if (baseA === t0 && targetA === t1) return { reserveBase: r0, reserveTarget: r1 };
          if (baseA === t1 && targetA === t0) return { reserveBase: r1, reserveTarget: r0 };

          return null;
        };

        const uni = align(uRes, inputToken, outputToken);
        const sushi = align(sRes, inputToken, outputToken);

        const uniBaseTarget = alignBaseTarget(uRes, baseToken, targetToken);
        const sushiBaseTarget = alignBaseTarget(sRes, baseToken, targetToken);

        updateEventLog({
          uni_reserve_base_raw: uniBaseTarget?.reserveBase ?? null,
          uni_reserve_target_raw: uniBaseTarget?.reserveTarget ?? null,
          sushi_reserve_base_raw: sushiBaseTarget?.reserveBase ?? null,
          sushi_reserve_target_raw: sushiBaseTarget?.reserveTarget ?? null
        });

        if (!uni && !sushi) {
          emitEventLog({ outcome: "skipped", reject_reason: "missing_reserves" });
          continue;
        }

        const uniIn = uni?.reserveIn ?? 0n;
        const sushiIn = sushi?.reserveIn ?? 0n;

        // ------------------------------
        // 🔒 CONDITIONAL HARD LIQUIDITY FLOOR & IMPACT CHECK
        // ------------------------------
        if (networkType !== "FORK") {
          const MIN_LIQUIDITY = 10n ** 17n; // 0.1 WETH
          const MAX_IMPACT_BPS = 200n; // 2%

          if (uniIn < MIN_LIQUIDITY || sushiIn < MIN_LIQUIDITY) {
            console.log(`❌ Skipping shallow pool | Uni=${uniIn} Sushi=${sushiIn}`);
            emitEventLog({
              liquidity_passed: false,
              outcome: "skipped",
              reject_reason: "shallow_pool"
            });
            continue;
          }

          const impactUni = uniIn > 0n ? (amountIn * 10000n) / uniIn : 10_000n;
          const impactSushi = sushiIn > 0n ? (amountIn * 10000n) / sushiIn : 10_000n;

          if (impactUni > MAX_IMPACT_BPS || impactSushi > MAX_IMPACT_BPS) {
            console.log(`❌ Skipping high impact trade | Uni=${impactUni}bps Sushi=${impactSushi}bps`);
            emitEventLog({
              liquidity_passed: true,
              outcome: "skipped",
              reject_reason: "impact_too_high"
            });
            continue;
          }
        }

        // ------------------------------
        // Now safe to compare pools or log
        // ------------------------------
        const reserveIn = uniIn > sushiIn ? uniIn : sushiIn;

        const SCALE = 1_000_000_000n;
        const impactScaled = (amountIn * SCALE) / reserveIn;
        const impactPct = Number(impactScaled) / 1e7;

        // ------------------------------
        // IMPACT CLASSIFICATION (fixed sensitivity)
        // ------------------------------
        let signal = "NORMAL";

        if (impactScaled < 10_000n) signal = "MICRO";        // <0.001%
        else if (impactScaled < 50_000n) signal = "LOW";     // 0.001% – 0.005%
        else if (impactScaled < 250_000n) signal = "GOOD";   // 0.005% – 0.025%
        else if (impactScaled < 2_000_000n) signal = "HIGH"; // 0.025% – 0.2%
        else signal = "EXTREME";                              // >0.2%

        console.log(`📊 Reserve Signal → Swap Size Relative To Reserve = ${impactPct.toFixed(6)}% | Signal=${signal}`);
        console.log(
          `📊 IMPACT DEBUG → raw=${amountIn.toString()} ` +
          `reserve=${reserveIn.toString()} ` +
          `scaled=${impactScaled.toString()} ` +
          `impact=${impactPct.toFixed(6)}% ` +
          `signal=${signal} ` +
          `gate=${impactScaled >= 25_000n ? "PASS" : "BLOCK"}`
        );
        console.log(ORANGE + "═══════════════════════════════════════════════════════════" + RESET);

        updateEventLog({
          impact_signal: signal,
          liquidity_passed: true
        });

        if (impactScaled < 25_000n) {
          emitEventLog({
            outcome: "skipped",
            reject_reason: "impact_too_low"
          });
          continue;
        }      // 0.0025%
        if (impactScaled > 200_000_000n) {
          emitEventLog({
            outcome: "skipped",
            reject_reason: "impact_too_high"
          });
          continue;
        }   // 20%

        // ============================================================
        // EXECUTION
        // ============================================================

        isExecutingTradePerPair[pairKey] = true;

        try {
          const directionLogContext = {};
          const direction = await determineDirection(
            exchange,
            inputToken,
            outputToken,
            usdcToken,
            amountIn,
            uFactory,
            sFactory,
            uRouter,
            sRouter,
            monitoringProvider,
            topTokens,
            pairLiquidityMap,
            oneSidedPairsMap,
            undefined,
            undefined,
            null,
            null,
            directionLogContext
          );

          updateEventLog(directionLogContext);

          if (!direction) {
            const rejectReason =
              directionLogContext.liquidity_passed === false
                ? "shallow_pool"
                : directionLogContext.spread_passed === false
                  ? "spread_below_threshold"
                  : "direction_unavailable";

            emitEventLog({
              outcome: "skipped",
              reject_reason: rejectReason
            });
            continue;
          }

          const avgWethPrice = (direction.uniWethPriceUSDC + direction.sushiWethPriceUSDC) / 2;

          const arbResult = await determineProfit({
            baseToken: direction.baseToken,
            targetToken: direction.targetToken,
            routerPath: direction.routerPath,
            routerNames: direction.routerNames,
            startingReserves: direction.startingReserves,
            endingReserves: direction.endingReserves,
            eventAmountIn: FLASH_LOAN_SIZE,
            networkType,
            wethPriceInUSDC: avgWethPrice,
            provider: executionProvider,
            uniWethPerTokenEnd: direction.uniWethPerTokenEnd,
            sushiWethPerTokenEnd: direction.sushiWethPerTokenEnd
          });

          const estProfitWethRaw = arbResult?.profitWETH ?? arbResult?.profit ?? null;
          const estProfitUsd = arbResult?.profitUsd ?? arbResult?.profitUSDC ?? null;
          const tradeSizeRaw = arbResult?.tradeAmount ?? null;

          if (!arbResult?.profitable || (arbResult.tradeAmount ?? 0n) <= 0n) {
            emitEventLog({
              outcome: "evaluated",
              reject_reason: "below_min_profit",
              est_profit_weth_raw: estProfitWethRaw,
              est_profit_usd: estProfitUsd,
              trade_size_raw: tradeSizeRaw
            });
            continue;
          }

          emitEventLog({
            outcome: "would_trade",
            reject_reason: null,
            est_profit_weth_raw: estProfitWethRaw,
            est_profit_usd: estProfitUsd,
            trade_size_raw: tradeSizeRaw
          });

          const result = await executeTrade({
            startOnUniswap: direction.routerPath[0] === uRouter,
            baseToken: direction.baseToken,
            targetToken: direction.targetToken,
            amountBorrowed: arbResult.tradeAmount,
            signer: refs.signer
          });

          lastTradePerPair[pairKey] = blockNumber;
          lastExecutionTimePerPair[pairKey] = Date.now();

          if (result?.hash) refs.lastSubmittedTxHash = result.hash;
          if (result?.receipt?.status === 1n) refs.goodTradesCounter++;

        } finally {
          isExecutingTradePerPair[pairKey] = false;
        }

      } finally {
        if (eventLogRecord && !eventLogEmitted) {
          emitEventLog({
            outcome: "skipped",
            reject_reason: "processing_stopped"
          });
        }

        refs.isGlobalExecuting = false;

        if (monitoringPaused && refs._swapQueue.length === 0) {
          resumeMonitoring();
        }
      }
    }

  } finally {
    refs._isProcessingSwapQueue = false;
  }
}

// ─────────────────────────────────────────────
// Determine Direction based on the Event Seen
// ─────────────────────────────────────────────
async function determineDirection(
  eventDex,
  inputToken,
  outputToken,
  usdcToken,
  eventAmountIn,
  uFactory,
  sFactory,
  uRouter,
  sRouter,
  provider,
  topTokens,
  pairLiquidityMap,
  oneSidedPairsMap,
  minWethReserve = 5n * 10n ** 18n,
  spreadThreshold = 1.0,
  snapshot = null,
  preFetchedReserves = null,
  eventLogContext = null
) {
  try {
    const ORANGE = "\x1b[38;5;208m";
    const RESET = "\x1b[0m";
    const border = () => console.log(ORANGE + "═══════════════════════════════════════════════════════════" + RESET);

    border();
    console.log("🚀 Determine Direction (Flash Loan Base = WETH)");
    border();

    if (typeof eventAmountIn !== "bigint") eventAmountIn = BigInt(eventAmountIn.toString());

    console.log(`\n📢 Swap Event Detected: ${inputToken.symbol} → ${outputToken.symbol}`);
    console.log(`Event Amount In: ${ethers.formatUnits(eventAmountIn, Number(inputToken.decimals))}`);

    const baseToken = topTokens.find(t => t.symbol === "WETH");
    if (!baseToken) return console.log("⚠️ No WETH in pair. Skipping.");

    const targetToken = inputToken.symbol === "WETH" ? outputToken : inputToken;
    const isBaseInput = inputToken.address.toLowerCase() === baseToken.address.toLowerCase();

    // ------------------- RESERVES -------------------
    const uniPair = await getReserves(uFactory, baseToken, targetToken, provider);
    const sushiPair = await getReserves(sFactory, baseToken, targetToken, provider);
    if (!uniPair || !sushiPair) return console.log("❌ Missing pair data");

    const uReserveBase = BigInt(uniPair.reserveA);
    const uReserveTarget = BigInt(uniPair.reserveB);
    const sReserveBase = BigInt(sushiPair.reserveA);
    const sReserveTarget = BigInt(sushiPair.reserveB);

    const startingReserves = { uBase: uReserveBase, uTarget: uReserveTarget, sBase: sReserveBase, sTarget: sReserveTarget };

    if (eventLogContext) {
      Object.assign(eventLogContext, {
        uni_reserve_base_raw: uReserveBase,
        uni_reserve_target_raw: uReserveTarget,
        sushi_reserve_base_raw: sReserveBase,
        sushi_reserve_target_raw: sReserveTarget
      });
    }

    // ------------------- WETH → USDC PRICE -------------------
    const uUsdcRes = await getReserves(uFactory, baseToken, usdcToken, provider);
    const sUsdcRes = await getReserves(sFactory, baseToken, usdcToken, provider);

    const getWethPriceInUSDC = (res) => {
      if (!res) return 0;
      const wethAddr = baseToken.address.toLowerCase();
      const wethReserve = res.token0.toLowerCase() === wethAddr ? res.reserve0 : res.reserve1;
      const usdcReserve = res.token0.toLowerCase() === wethAddr ? res.reserve1 : res.reserve0;
      return Number(ethers.formatUnits(usdcReserve, usdcToken.decimals)) / Number(ethers.formatEther(wethReserve));
    };

    const uniWethPriceUSDC = getWethPriceInUSDC(uUsdcRes);
    const sushiWethPriceUSDC = getWethPriceInUSDC(sUsdcRes);

    // ------------------- SIMULATE SWAP -------------------
    function simulateSwap(reserveIn, reserveOut, amountIn) {
      const amountInWithFee = (amountIn * 997n) / 1000n;
      const amountOut = (amountInWithFee * reserveOut) / (reserveIn + amountInWithFee);
      return { newReserveIn: reserveIn + amountIn, newReserveOut: reserveOut - amountOut };
    }

    const endingReserves = { ...startingReserves };
    if (eventDex.toLowerCase() === "uniswap") {
      const swap = isBaseInput ? simulateSwap(uReserveBase, uReserveTarget, eventAmountIn) : simulateSwap(uReserveTarget, uReserveBase, eventAmountIn);
      endingReserves.uBase = isBaseInput ? swap.newReserveIn : swap.newReserveOut;
      endingReserves.uTarget = isBaseInput ? swap.newReserveOut : swap.newReserveIn;
    } else {
      const swap = isBaseInput ? simulateSwap(sReserveBase, sReserveTarget, eventAmountIn) : simulateSwap(sReserveTarget, sReserveBase, eventAmountIn);
      endingReserves.sBase = isBaseInput ? swap.newReserveIn : swap.newReserveOut;
      endingReserves.sTarget = isBaseInput ? swap.newReserveOut : swap.newReserveIn;
    }

    // ------------------- PRICE PER TOKEN (BIGINT SAFE) -------------------

    const SCALED = 10n ** BigInt(targetToken.decimals);

    // WETH per TOKEN (AMM price = reserveWETH / reserveTOKEN)
    const uniWethPerTokenStart = startingReserves.uTarget > 0n ? (startingReserves.uBase * SCALED) / startingReserves.uTarget : 0n;
    const uniWethPerTokenEnd = endingReserves.uTarget > 0n ? (endingReserves.uBase * SCALED) / endingReserves.uTarget : 0n;
    const sushiWethPerTokenStart = startingReserves.sTarget > 0n ? (startingReserves.sBase * SCALED) / startingReserves.sTarget : 0n;
    const sushiWethPerTokenEnd = endingReserves.sTarget > 0n ? (endingReserves.sBase * SCALED) / endingReserves.sTarget : 0n;

    const uniUsdcPerTokenStart = uniWethPriceUSDC ? Number(ethers.formatUnits(uniWethPerTokenStart, targetToken.decimals)) * uniWethPriceUSDC : 0;
    const uniUsdcPerTokenEnd = uniWethPriceUSDC ? Number(ethers.formatUnits(uniWethPerTokenEnd, targetToken.decimals)) * uniWethPriceUSDC : 0;
    const sushiUsdcPerTokenStart = sushiWethPriceUSDC ? Number(ethers.formatUnits(sushiWethPerTokenStart, targetToken.decimals)) * sushiWethPriceUSDC : 0;
    const sushiUsdcPerTokenEnd = sushiWethPriceUSDC ? Number(ethers.formatUnits(sushiWethPerTokenEnd, targetToken.decimals)) * sushiWethPriceUSDC : 0;

    // ------------------- SPREAD -------------------
    const buyPrice = uniWethPerTokenEnd < sushiWethPerTokenEnd ? uniWethPerTokenEnd : sushiWethPerTokenEnd;
    const sellPrice = uniWethPerTokenEnd > sushiWethPerTokenEnd ? uniWethPerTokenEnd : sushiWethPerTokenEnd;
    const spreadBps = buyPrice > 0n ? ((sellPrice - buyPrice) * 10_000n) / buyPrice : 0n;
    const pctWeth = Number(spreadBps) / 100;

    // ------------------- LIQUIDITY -------------------
    const uniLiquidity = evaluateLiquidity({ reserveBase: endingReserves.uBase, minWethReserve, dexName: "Uniswap" });
    const sushiLiquidity = evaluateLiquidity({ reserveBase: endingReserves.sBase, minWethReserve, dexName: "Sushi" });
    const liquidityPassed = uniLiquidity.valid && sushiLiquidity.valid;
    const spreadPassed = Math.abs(pctWeth) >= spreadThreshold;

    if (eventLogContext) {
      Object.assign(eventLogContext, {
        spread_bps: Number(spreadBps),
        liquidity_passed: liquidityPassed,
        spread_passed: spreadPassed
      });
    }

    const uniWethReserve = getWethReserve(uniPair, baseToken.address);
    const sushiWethReserve = getWethReserve(sushiPair, baseToken.address);

    // ------------------- LOGGING (DIRECTION-AWARE HUMAN MODEL) -------------------

    const toNum = (x) => Number(x);

    const pricePerTokenWeth = (wethReserve, tokenReserve) => {
      if (tokenReserve <= 0n) return 0;
      return toNum(ethers.formatEther(wethReserve)) /
             toNum(ethers.formatUnits(tokenReserve, targetToken.decimals));
    };

    const pricePerTokenUsdc = (wethPerToken) => wethPerToken * uniWethPriceUSDC;

    const isUniAffected = eventDex.toLowerCase() === "uniswap";

    // ---- UNISWAP PRICES ----
    const uniWethBefore = pricePerTokenWeth(startingReserves.uBase, startingReserves.uTarget);
    const uniWethAfter  = pricePerTokenWeth(endingReserves.uBase, endingReserves.uTarget);

    const uniUsdcBefore = pricePerTokenUsdc(uniWethBefore);
    const uniUsdcAfter  = pricePerTokenUsdc(uniWethAfter);

    // ---- SUSHI PRICES ----
    const sushiWethBefore = pricePerTokenWeth(startingReserves.sBase, startingReserves.sTarget);
    const sushiWethAfter  = pricePerTokenWeth(endingReserves.sBase, endingReserves.sTarget);

    const sushiUsdcBefore = pricePerTokenUsdc(sushiWethBefore);
    const sushiUsdcAfter  = pricePerTokenUsdc(sushiWethAfter);

    // ---- PCT CHANGE ----
    const pctChange = (before, after) =>
      before > 0 ? (((after - before) / before) * 100).toFixed(4) : "0.0000";

    console.log("\n💸 Price BEFORE Swap");

    console.log(`Uniswap:`);
    console.log(`1 ${targetToken.symbol} ≈ ${uniWethBefore.toFixed(18)} WETH`);
    console.log(`1 ${targetToken.symbol} ≈ ${uniUsdcBefore.toFixed(6)} USDC`);

    console.log(`Sushi:`);
    console.log(`1 ${targetToken.symbol} ≈ ${sushiWethBefore.toFixed(18)} WETH`);
    console.log(`1 ${targetToken.symbol} ≈ ${sushiUsdcBefore.toFixed(6)} USDC`);

    console.log("\n💸 Price AFTER Swap");

    // ONLY affected DEX updates
    if (isUniAffected) {
      console.log(`Uniswap:`);
      console.log(`1 ${targetToken.symbol} ≈ ${uniWethAfter.toFixed(18)} WETH`);
      console.log(`1 ${targetToken.symbol} ≈ ${uniUsdcAfter.toFixed(6)} USDC`);

      console.log(`Sushi:`);
      console.log(`1 ${targetToken.symbol} ≈ ${sushiWethBefore.toFixed(18)} WETH`);
      console.log(`1 ${targetToken.symbol} ≈ ${sushiUsdcBefore.toFixed(6)} USDC`);
    } else {
      console.log(`Uniswap:`);
      console.log(`1 ${targetToken.symbol} ≈ ${uniWethBefore.toFixed(18)} WETH`);
      console.log(`1 ${targetToken.symbol} ≈ ${uniUsdcBefore.toFixed(6)} USDC`);

      console.log(`Sushi:`);
      console.log(`1 ${targetToken.symbol} ≈ ${sushiWethAfter.toFixed(18)} WETH`);
      console.log(`1 ${targetToken.symbol} ≈ ${sushiUsdcAfter.toFixed(6)} USDC`);
    }

    console.log("\n📊 Price Change");

    console.log(`Uniswap Δ %: ${pctChange(uniWethBefore, uniWethAfter)}%`);
    console.log(`Sushi Δ %:   ${pctChange(sushiWethBefore, sushiWethAfter)}%`);

    console.log(`\n🔺 Direct Arb Spread: ${pctWeth.toFixed(2)}%`);

    console.log("\n📈 Reserves");
    console.log(`Uniswap WETH Reserve: ${ethers.formatEther(uniWethReserve)}`);
    console.log(`Sushi WETH Reserve: ${ethers.formatEther(sushiWethReserve)}`);

    console.log(`\n💧 Liquidity Status: ${liquidityPassed ? "Passed ✅" : "Failed ❌"}`);
    console.log(`📊 Spread Status: ${spreadPassed ? "Passed ✅" : `Failed ❌ (${pctWeth.toFixed(2)}%)`}`);

    border();

    if (!liquidityPassed || !spreadPassed) return null;

    // ------------------- TRADE PATH -------------------
    const routerPath = uniWethPerTokenEnd > sushiWethPerTokenEnd ? [sRouter, uRouter] : [uRouter, sRouter];
    const routerNames = uniWethPerTokenEnd > sushiWethPerTokenEnd ? ["Sushi", "Uniswap"] : ["Uniswap", "Sushi"];
    console.log("\n💸 Arbitrage Trade Path:");
    console.log(`${baseToken.symbol} → ${targetToken.symbol} → ${baseToken.symbol}`);
    console.log(`Execution Routers: ${routerNames.join(" → ")}`);
    border();

    return {
      baseToken,
      targetToken,
      bridgeToken: null,
      routerPath,
      routerNames,
      priceDifferencePct: pctWeth,
      startingReserves,
      endingReserves,
      uniWethPerTokenStart,
      uniWethPerTokenEnd,
      sushiWethPerTokenStart,
      sushiWethPerTokenEnd,
      uniUsdcPerTokenStart,
      uniUsdcPerTokenEnd,
      sushiUsdcPerTokenStart,
      sushiUsdcPerTokenEnd,
      uniWethPriceUSDC,
      sushiWethPriceUSDC,
      liquidityPassed,
      spreadPassed,
      spreadBps: Number(spreadBps),
      uniWethReserve,
      sushiWethReserve
    };

  } catch (err) {
    console.error("Error determining direction:", err);
    return null;
  }
}

// ─────────────────────────────────────────────
// Determine profit including percentage and DEX differences
// ─────────────────────────────────────────────
async function determineProfit({
  baseToken,
  targetToken,
  bridgeToken,
  routerPath,               // array of Contract objects
  routerNames,              // array of string names
  tradePath,                // array of { inToken, outToken }
  endingReserves,
  networkType,
  wethPriceInUSDC,
  provider,
  uniWethPerTokenEnd,       // from determineDirection
  sushiWethPerTokenEnd,     // from determineDirection
  maxSlippagePercent = 1n,  // 1% max % of pool allowed to trade
  gasUsed = 150_000n,       // default gas units for estimation
  gasPrice = 0n             // in wei
}) {
  try {
    const chalk = require("chalk");
    const orange = chalk.rgb(255, 140, 0);

    console.log(orange("════════════════════════════════════════════"));
    console.log("🚀 Determine Profit (2 Token Arbitrage)");
    console.log(orange("════════════════════════════════════════════"));
    console.log("Base:", baseToken.symbol);
    console.log("Target:", targetToken.symbol, "\n");

    const wethPrice = Number(wethPriceInUSDC ?? 0);
    console.log("WETH Price (USDC):", wethPrice, "\n");

    // ------------------ Ensure tradePath exists ------------------
    if (!tradePath || !Array.isArray(tradePath) || tradePath.length === 0) {
      tradePath = [{ inToken: baseToken, outToken: targetToken }];
    }

    // ------------------ Ensure routerPath exists ------------------
    if (!routerPath || !Array.isArray(routerPath) || routerPath.length === 0) {
      throw new Error(`Invalid routerPath: ${JSON.stringify(routerNames)}`);
    }

    // ------------------ GET RESERVES (TRUST DIRECTION OUTPUT) ------------------

    const getReserveSet = (dex) => {
      if (dex === "Uniswap") {
        return {
          in: endingReserves.uBase,
          out: endingReserves.uTarget
        };
      }

      if (dex === "Sushi") {
        return {
          in: endingReserves.sBase,
          out: endingReserves.sTarget
        };
      }

      throw new Error(`Unknown DEX: ${dex}`);
    };

    // 2-token or 3-token doesn't matter anymore
    const buy = getReserveSet(routerNames[0]);
    const sell = getReserveSet(routerNames[routerNames.length - 1]);

    const buyReserveIn   = buy.in;
    const buyReserveOut  = buy.out;

    const sellReserveIn  = sell.in;
    const sellReserveOut = sell.out;

    // ------------------ Max Flash Loan & Slippage-Limited Trade ------------------
    // Ensure flashLoanMax is BigInt (in smallest units, e.g., wei)
    const flashLoanMax = getFlashLoanSize(networkType); 
    console.log(
      "Flash Loan Max:",
      ethers.formatUnits(flashLoanMax, baseToken.decimals),
      baseToken.symbol
    );

    // Ensure maxSlippagePercent is BigInt
    const maxSlippageBps = maxSlippagePercent * 100n; // <-- all BigInt math

    if (maxSlippageBps <= 0n) throw new Error("maxSlippagePercent must be > 0");

    // Compute max trade allowed to respect slippage
    const maxImpactTrade = (buyReserveIn * maxSlippageBps) / 10000n; // divide by 10000 bps
    const cappedMaxTrade = flashLoanMax < maxImpactTrade ? flashLoanMax : maxImpactTrade;

    // ------------------ Optimal Trade Size Search (GROSS round-trip) ------------------
    // BUG #1 FIX (decimals/units): the old inner helper (getOptimalTrade) compared a
    // TARGET-token amount, (trade*sellOut)/(sellIn+trade), against a BASE-token (WETH)
    // amount as if they shared units. That only works when the target token also has 18
    // decimals (DAI). For USDC/USDT (6dp) and WBTC (8dp) the raw integer magnitudes
    // differ by ~1e10–1e12, so the pre-check was ALWAYS negative and the function bailed
    // before the real round trip ran (=> est_profit_usd logged as null for those pairs).
    //
    // The decision is now driven entirely off estimateMaxProfit, which performs a
    // correct, fully WETH-denominated two-swap round trip (WETH -> token -> WETH).
    // Because both the input (tradeSize) and the output (swap2Out) are measured in WETH,
    // the result is correct for tokens of ANY decimals.
    //
    // BUG #2 FIX (arbitrary trade size): instead of a single fixed "1% of pool" size, we
    // evaluate a small, fixed handful of candidate sizes (fractions of the
    // slippage/flash-loan-capped max — which is itself a fraction of the buy pool's WETH
    // reserve) and keep the size with the highest GROSS round-trip profit.
    //
    // GROSS = pure price-difference (swap2Out - tradeSize), before gas & fees. We do NOT
    // model gas/costs here; gas inputs stay 0.

    const CANDIDATE_FRACTIONS_BPS = [1000n, 2500n, 5000n, 7500n, 10000n]; // 10%..100% of cap

    let bestTradeSize = 0n;
    let bestGrossProfitWeth = null; // signed WETH (18dp); null until first valid round trip

    for (const fracBps of CANDIDATE_FRACTIONS_BPS) {
      const candidate = (cappedMaxTrade * fracBps) / 10000n;
      if (candidate <= 0n) continue;

      const est = await estimateMaxProfit({
        buyReserveIn,
        buyReserveOut,
        sellReserveIn,
        sellReserveOut,
        tradeSize: candidate,
        gasUsed: 0n,    // gas inputs held at 0 — we do not model gas/costs
        gasPrice: 0n    // GROSS metric below ignores gas/fees entirely (swap2Out - candidate)
      });
      if (!est) continue;

      // GROSS round-trip profit (WETH out - WETH in), signed; before gas & fees.
      const grossWeth = est.swap2Out - candidate;

      if (bestGrossProfitWeth === null || grossWeth > bestGrossProfitWeth) {
        bestGrossProfitWeth = grossWeth;
        bestTradeSize = candidate;
      }
    }

    // Only bail STRUCTURALLY (degenerate reserves) — never purely due to token decimals.
    if (bestGrossProfitWeth === null) {
      console.log("Could not estimate round-trip profit (degenerate reserves).");
      console.log(orange("════════════════════════════════════════════"));
      return {
        profitable: false,
        tradeAmount: 0n,
        profit: 0n,
        profitWETH: 0n,
        profitUSDC: 0,
        profitUsd: 0
      };
    }

    const maxTradeAllowed = bestTradeSize;

    console.log(
      "Best Trade Size (GROSS-maximizing, slippage-capped):",
      ethers.formatUnits(maxTradeAllowed, baseToken.decimals),
      baseToken.symbol,
      "\n"
    );

    // ------------------ GROSS Profit (WETH/USD, signed; before gas) ------------------
    const profitInWeth = Number(ethers.formatUnits(bestGrossProfitWeth, 18));
    const profitInUsd = profitInWeth * wethPrice; // GROSS (before gas)

    // ------------------ MIN GROSS PROFIT THRESHOLD ($5) ------------------
    // (Renamed from the misleading MAX_PROFIT_USD whose comment said "$10 min" while it
    // was actually used as a $5 MINIMUM-profit threshold. Value unchanged.)
    const MIN_PROFIT_USD = 5; // $5 minimum GROSS profit to flag as would-trade

    const isAboveMinProfit = profitInUsd >= MIN_PROFIT_USD;

    const slippageBps = 50n; // define early
    const profitUSDC = profitInUsd;
    const roiPercent =
      maxTradeAllowed > 0n
        ? (profitInWeth / Number(ethers.formatUnits(maxTradeAllowed, 18))) * 100
        : 0;

    console.log("Profit (WETH, GROSS):", ethers.formatUnits(bestGrossProfitWeth, baseToken.decimals));
    console.log("Profit (USD, GROSS):", profitUSDC.toFixed(6));
    console.log("ROI (GROSS):", roiPercent.toFixed(2) + "%");

    // Always surface REAL gross numbers (positive, zero, or negative) so the event log
    // never shows null purely because of token decimals.
    if (!isAboveMinProfit) {
      console.log(`Arbitrage Profitable: NO ❌ (GROSS below $${MIN_PROFIT_USD} threshold)`);
      console.log(orange("════════════════════════════════════════════"));
      return {
        profitable: false,
        tradeAmount: 0n,
        profit: bestGrossProfitWeth,
        profitWETH: bestGrossProfitWeth,
        profitUSDC,
        profitUsd: profitInUsd,
        slippageBps
      };
    }

    // ------------------ Compute Buy/Sell Prices (display only) ------------------
    const buyPriceRaw  =
      routerNames[0] === "Uniswap" ? uniWethPerTokenEnd : sushiWethPerTokenEnd;

    const sellPriceRaw =
      routerNames[1] === "Uniswap" ? uniWethPerTokenEnd : sushiWethPerTokenEnd;

    const buyPrice = Number(ethers.formatUnits(buyPriceRaw, 18));
    const sellPrice = Number(ethers.formatUnits(sellPriceRaw, 18));

    // ------------------ Display ------------------
    console.log(`Buy Price  (${routerNames[0]}):`, buyPrice.toFixed(9), baseToken.symbol);
    console.log(`Sell Price (${routerNames[1]}):`, sellPrice.toFixed(9), baseToken.symbol, "\n");

    console.log(orange("════════════════════════════════════════════"));
    console.log("Arbitrage Profitable:", "YES ✅ (GROSS)");
    console.log(orange("════════════════════════════════════════════"));

    return {
      profitable: true,
      reason: "ABOVE_MIN_PROFIT_THRESHOLD",
      tradeAmount: maxTradeAllowed,
      profit: bestGrossProfitWeth,
      profitWETH: bestGrossProfitWeth,
      profitUSDC,
      profitUsd: profitInUsd,
      slippageBps
    };

  } catch (err) {
    console.error("determineProfit error:", err);
    return { profitable: false, tradeAmount: 0n, profit: 0n };
  }
}

// ─────────────────────────────────────────
// EXECUTE TRADE (2-TOKEN OR TRIANGULAR)
// ─────────────────────────────────────────
async function executeTrade({
  startOnUniswap,
  baseToken,
  targetToken,
  amountBorrowed,
  signer
}) {
  if (!signer) {
    throw new Error("Signer is required");
  }

  const arb = arbitrage.connect(signer);

  try {
    // ---------------- ORANGE BORDER ----------------
    const now = new Date();
    const timestamp = now.toLocaleString("en-US", { hour12: true });

    console.log(orange("═══════════════════════════════════════════════════════════"));
    console.log(orange("🚀 Executing Trade (Flash Loan Arbitrage)"));
    console.log(orange("═══════════════════════════════════════════════════════════"));

    console.log(`🕒 Timestamp: ${timestamp}`);
    console.log("🚀 Executing Arbitrage Trade");
    console.log(`Borrowing Amount: ${ethers.formatUnits(amountBorrowed, baseToken.decimals)} ${baseToken.symbol}`);
    console.log(`Start On Uniswap: ${startOnUniswap}`);

    if (PROJECT_SETTINGS.SIMULATE_TRADES) {
      if (PROJECT_SETTINGS.isLocal) {
        // Simulate on local/forked network (perform all steps as if it's a real trade)
        console.log("⚠️ Simulating trade on local network... Performing all steps as if it were real.");
        // Simulate the trade here
        console.log("🧱 Block number (simulation): 24548821"); // Example block number
        console.log("✅ Simulated trade completed on local network.");
        console.log(orange("═══════════════════════════════════════════════════════════"));
        return {
          hash: null, // No transaction hash in simulation
          receipt: null // No receipt in simulation
        };
      } else {
        // Simulate on live network (do not broadcast)
        console.log("⚠️ Simulating trade... No real transaction will be sent.");
        console.log("✅ Simulated trade completed on live network.");
        console.log(orange("═══════════════════════════════════════════════════════════"));
        return {
          hash: null, // No transaction hash
          receipt: null // No receipt
        };
      }
    }

    // If not in simulation mode, execute the real trade
    const tx = await arb.executeTrade(
      startOnUniswap,
      baseToken.address,
      targetToken.address,
      ethers.ZeroAddress,
      amountBorrowed, 
      slippageBps
    );

    console.log(`📨 Transaction sent: ${tx.hash}`);

    // Wait for receipt (real trade)
    const receipt = await tx.wait();

    if (receipt.status !== 1) {
      throw new Error("Transaction reverted on-chain");
    }

    console.log(`✅ Trade mined in block: ${receipt.blockNumber}`);
    console.log(orange("═══════════════════════════════════════════════════════════\n"));

    return {
      hash: tx.hash,
      receipt
    };
  } catch (err) {
    console.error(orange("❌ Trade execution failed:"), err);
    throw err;
  }
}

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────
main().catch(console.error);

// Works !! Both Pump and Dump tests work. Works on Mainnet too it seems. 
