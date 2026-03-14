const express = require("express");
const axios = require("axios");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const path = require("path");
const app = express();

app.use(express.json());
app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));

// ╔══════════════════════════════════════════════════════════════╗
// ║           KALSHI ARBITRAGE AGENT — PRIVACY NOTICE          ║
// ║                                                             ║
// ║  This agent ONLY accesses:                                  ║
// ║  ✅ Public market data (prices, odds)                       ║
// ║  ✅ Your Kalshi portfolio balance                           ║
// ║  ✅ Place YES/NO trade orders                               ║
// ║  ✅ View open positions                                     ║
// ║                                                             ║
// ║  This agent NEVER accesses:                                 ║
// ║  ❌ Social Security Number                                  ║
// ║  ❌ Bank account or routing numbers                         ║
// ║  ❌ Personal identity information                           ║
// ║  ❌ Login password or credentials                           ║
// ║  ❌ Withdrawal or money transfer functions                  ║
// ║  ❌ Deposit functions — cannot add money to your account    ║
// ║  ❌ Any financial transaction outside of trading            ║
// ╚══════════════════════════════════════════════════════════════╝

// ── Safety Guard — Block Any Deposit/Withdrawal Attempts ──────
// This function is called before every API request to Kalshi
// It will throw an error if any request tries to access
// deposit, withdrawal, or account funding endpoints
function safetyCheck(url) {
  const BLOCKED_ENDPOINTS = [
    "/funding",
    "/deposit",
    "/withdraw",
    "/bank",
    "/transfer",
    "/ach",
    "/wire",
    "/payment",
  ];
  const lower = url.toLowerCase();
  for (const blocked of BLOCKED_ENDPOINTS) {
    if (lower.includes(blocked)) {
      throw new Error(`🚨 BLOCKED: Agent attempted to access forbidden endpoint: ${url}`);
    }
  }
}

// ── Safe Axios Wrapper ────────────────────────────────────────
// All Kalshi API calls go through this wrapper
// It checks every URL before making the request
async function safeRequest(method, url, data = null) {
  safetyCheck(url); // Block deposits/withdrawals
  const config = { method, url, headers: kalshiHeaders };
  if (data) config.data = data;
  const response = await axios(config);
  return response.data;
}

// ── Rate Limiting ─────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: "Too many requests. Please slow down." },
});
app.use(limiter);

// ── Config ────────────────────────────────────────────────────
const KALSHI_KEY    = process.env.KALSHI_KEY;
const KALSHI_SECRET = process.env.KALSHI_SECRET;
const AGENT_SECRET  = process.env.AGENT_SECRET;
const BASE_URL      = "https://trading.kalshi.com/trade-api/v2";

// Minimum 5% margin to account for Kalshi fees
const MIN_MARGIN    = parseFloat(process.env.MIN_MARGIN || "0.05");

// $1.00 max bet per trade
const MAX_BET       = parseInt(process.env.MAX_BET || "100");

// Maximum total portfolio exposure — agent stops trading if
// total open position value exceeds this amount in cents
const MAX_EXPOSURE  = parseInt(process.env.MAX_EXPOSURE || "2000"); // $20.00

const kalshiHeaders = {
  "Authorization": `Bearer ${KALSHI_KEY}`,
  "Content-Type":  "application/json",
};

// ── Auth Middleware ───────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers["x-agent-secret"] || req.query.secret;
  if (!token || token !== AGENT_SECRET) {
    log(`🚨 Unauthorized access attempt from ${req.ip}`);
    return res.status(401).json({ error: "Unauthorized." });
  }
  next();
}

// ── Agent State ───────────────────────────────────────────────
let agentRunning  = false;
let agentInterval = null;
let pingInterval  = null;
let tradeLog      = [];
let opportunities = [];
let stats = {
  scans:              0,
  opportunitiesFound: 0,
  tradesPlaced:       0,
  totalProfitCents:   0,
  blockedAttempts:    0,
  lastScan:           null,
  errors:             0,
};

function log(msg, type = "info") {
  // API keys and secrets are NEVER logged
  const entry = { time: new Date().toISOString(), msg, type };
  tradeLog.unshift(entry);
  if (tradeLog.length > 200) tradeLog.pop();
  console.log(`[${entry.time}] ${msg}`);
}

// ── Keep Alive Ping (prevents Render from sleeping) ───────────
function startKeepAlive() {
  const appUrl = process.env.RENDER_EXTERNAL_URL;
  if (!appUrl) {
    log("⚠️ RENDER_EXTERNAL_URL not set — keep alive disabled", "error");
    return;
  }
  pingInterval = setInterval(async () => {
    try {
      await axios.get(`${appUrl}/health`);
      log("💓 Keep alive ping sent", "info");
    } catch (e) {
      log(`⚠️ Keep alive ping failed: ${e.message}`, "error");
    }
  }, 10 * 60 * 1000); // ping every 10 minutes
  log("💓 Keep alive started — pinging every 10 minutes");
}

// ── Kalshi API Helpers ────────────────────────────────────────
async function getMarkets(cursor = "") {
  const url = `${BASE_URL}/markets?status=open&limit=100${cursor ? `&cursor=${cursor}` : ""}`;
  return safeRequest("GET", url);
}

async function getAllMarkets() {
  let allMarkets = [];
  let cursor = "";
  let page = 0;
  do {
    const data = await getMarkets(cursor);
    allMarkets = allMarkets.concat(data.markets || []);
    cursor = data.cursor || "";
    page++;
    if (page > 10) break;
    // Rate limit protection — wait 500ms between pages
    await new Promise(r => setTimeout(r, 500));
  } while (cursor);
  return allMarkets;
}

async function getBalance() {
  return safeRequest("GET", `${BASE_URL}/portfolio/balance`);
}

async function getPositions() {
  const data = await safeRequest("GET", `${BASE_URL}/portfolio/positions`);
  return data.market_positions || [];
}

// Calculate total current exposure across all open positions
async function getTotalExposure() {
  const positions = await getPositions();
  return positions.reduce((sum, p) => sum + Math.abs(p.market_exposure || 0), 0);
}

// ── Safe Order Placement ──────────────────────────────────────
// Only places buy orders for YES/NO contracts
// Cannot deposit, withdraw, or transfer money
async function placeOrder(marketTicker, side, count, price) {
  // Double check this is only a trade order
  if (!["yes", "no"].includes(side)) {
    throw new Error(`🚨 BLOCKED: Invalid order side: ${side}`);
  }
  if (count < 1 || count > 100) {
    throw new Error(`🚨 BLOCKED: Invalid contract count: ${count}`);
  }
  if (price < 1 || price > 99) {
    throw new Error(`🚨 BLOCKED: Invalid price: ${price}`);
  }
  return safeRequest("POST", `${BASE_URL}/portfolio/orders`, {
    ticker:    marketTicker,
    action:    "buy",
    side:      side,
    count:     count,
    type:      "limit",
    yes_price: side === "yes" ? price : 100 - price,
    no_price:  side === "no"  ? price : 100 - price,
  });
}

// ── Arbitrage Detection ───────────────────────────────────────
function detectArbitrage(market) {
  const yesBid = market.yes_bid;
  const noBid  = market.no_bid;
  if (!yesBid || !noBid) return null;
  const totalCost   = yesBid + noBid;
  const profitCents = 100 - totalCost;
  const margin      = profitCents / 100;
  if (margin >= MIN_MARGIN) {
    return {
      ticker:      market.ticker,
      title:       market.title,
      yesBid, noBid, totalCost, profitCents,
      margin:      (margin * 100).toFixed(2) + "%",
      marginRaw:   margin,
      detectedAt:  new Date().toISOString(),
    };
  }
  return null;
}

// ── Main Arbitrage Scan ───────────────────────────────────────
async function scanForArbitrage() {
  log("🔍 Scanning Kalshi markets for arbitrage...", "scan");
  stats.scans++;
  stats.lastScan = new Date().toISOString();

  try {
    // Check total exposure before trading
    const exposure = await getTotalExposure();
    if (exposure >= MAX_EXPOSURE) {
      log(`⚠️ Max exposure reached ($${(exposure/100).toFixed(2)}). Skipping trades until positions close.`, "error");
      return;
    }

    // Check balance before trading
    const bal = await getBalance();
    const balance = bal.balance || 0;
    if (balance < MAX_BET) {
      log(`⚠️ Insufficient balance ($${(balance/100).toFixed(2)}). Minimum needed: $${(MAX_BET/100).toFixed(2)}`, "error");
      return;
    }

    const markets = await getAllMarkets();
    log(`📊 Scanning ${markets.length} open markets...`);

    const found = [];
    for (const market of markets) {
      const arb = detectArbitrage(market);
      if (arb) {
        found.push(arb);
        stats.opportunitiesFound++;
        log(`💰 ARBITRAGE FOUND: ${arb.title} | Margin: ${arb.margin}`, "opportunity");
      }
    }

    opportunities = found.sort((a, b) => b.marginRaw - a.marginRaw);

    if (found.length === 0) {
      log("⏸ No arbitrage opportunities found this scan.");
    } else {
      log(`✅ Found ${found.length} opportunities. Top: ${found[0]?.title} (${found[0]?.margin})`);
      for (const opp of found.slice(0, 3)) {
        await executeArbitrage(opp);
        // Wait between trades to avoid rate limiting
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  } catch (err) {
    stats.errors++;
    if (err.message.includes("BLOCKED")) {
      stats.blockedAttempts++;
      log(`🚨 SAFETY BLOCK: ${err.message}`, "error");
    } else {
      log(`⚠️ Scan error: ${err.message}`, "error");
    }
  }
}

// ── Execute Arbitrage Trade ───────────────────────────────────
async function executeArbitrage(opp) {
  try {
    const contracts = Math.max(1, Math.floor(MAX_BET / opp.totalCost));
    const totalCost = contracts * opp.totalCost;

    // Final safety check — never spend more than MAX_BET
    if (totalCost > MAX_BET) {
      log(`⚠️ Trade cost $${(totalCost/100).toFixed(2)} exceeds max bet $${(MAX_BET/100).toFixed(2)} — skipping`, "error");
      return;
    }

    log(`🤖 Executing: ${opp.ticker} — ${contracts} YES @ ${opp.yesBid}¢ + ${contracts} NO @ ${opp.noBid}¢`);

    // Place YES order
    await placeOrder(opp.ticker, "yes", contracts, opp.yesBid);
    // Wait between orders to reduce slippage risk
    await new Promise(r => setTimeout(r, 500));
    // Place NO order
    await placeOrder(opp.ticker, "no", contracts, opp.noBid);

    const totalProfit = opp.profitCents * contracts;
    stats.tradesPlaced += 2;
    stats.totalProfitCents += totalProfit;

    log(`✅ Done! Expected profit: $${(totalProfit/100).toFixed(2)}`, "trade");
  } catch (err) {
    stats.errors++;
    log(`⚠️ Trade error on ${opp.ticker}: ${err.message}`, "error");
  }
}

// ── Routes ────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("🤖 Kalshi Arbitrage Agent is running!"));
app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "kalshi_dashboard.html")));
app.get("/privacy", (req, res) => res.json({
  accesses:         ["Public market prices", "Portfolio balance", "Open positions", "Place YES/NO orders"],
  never_accesses:   ["SSN", "Bank info", "Personal identity", "Password", "Withdrawals", "Deposits"],
  max_bet_cents:    MAX_BET,
  min_margin:       MIN_MARGIN,
  max_exposure:     MAX_EXPOSURE,
}));

app.get("/status", requireAuth, async (req, res) => {
  try {
    const balance   = await getBalance();
    const positions = await getPositions();
    const exposure  = await getTotalExposure();
    res.json({ agentRunning, stats, balance, positions, exposure, opportunities: opportunities.slice(0, 10), log: tradeLog.slice(0, 20) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/agent/start", requireAuth, (req, res) => {
  if (agentRunning) return res.json({ msg: "Agent already running" });
  agentRunning = true;
  scanForArbitrage();
  agentInterval = setInterval(scanForArbitrage, 60 * 1000);
  startKeepAlive();
  log("▶ Arbitrage agent started — scanning every 60 seconds");
  res.json({ msg: "Agent started" });
});

app.post("/agent/stop", requireAuth, (req, res) => {
  agentRunning = false;
  clearInterval(agentInterval);
  clearInterval(pingInterval);
  log("⏹ Agent stopped");
  res.json({ msg: "Agent stopped" });
});

app.get("/opportunities", requireAuth, (req, res) => res.json(opportunities));
app.get("/log",           requireAuth, (req, res) => res.json(tradeLog));
app.get("/stats",         requireAuth, (req, res) => res.json(stats));

app.post("/scan", requireAuth, async (req, res) => {
  res.json({ msg: "Scan triggered" });
  await scanForArbitrage();
});

app.get("/balance", requireAuth, async (req, res) => {
  try { res.json(await getBalance()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/positions", requireAuth, async (req, res) => {
  try { res.json(await getPositions()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.use((req, res) => res.status(404).json({ error: "Route not found" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Kalshi Arbitrage Agent running on port ${PORT}`);
  startKeepAlive();
});
