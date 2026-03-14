const express = require("express");
const axios = require("axios");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const path = require("path");
const crypto = require("crypto");
const app = express();

app.use(express.json());
app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));

function safetyCheck(url) {
  const BLOCKED_ENDPOINTS = ["/funding","/deposit","/withdraw","/bank","/transfer","/ach","/wire","/payment"];
  const lower = url.toLowerCase();
  for (const blocked of BLOCKED_ENDPOINTS) {
    if (lower.includes(blocked)) {
      throw new Error(`🚨 BLOCKED: Agent attempted to access forbidden endpoint: ${url}`);
    }
  }
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: "Too many requests. Please slow down." },
});
app.use(limiter);

const KALSHI_KEY_ID      = process.env.KALSHI_KEY_ID;
const KALSHI_PRIVATE_KEY = (process.env.KALSHI_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const AGENT_SECRET       = process.env.AGENT_SECRET;
const BASE_URL           = "https://trading.kalshi.com/trade-api/v2";
const MIN_MARGIN         = parseFloat(process.env.MIN_MARGIN || "0.05");
const MAX_BET            = parseInt(process.env.MAX_BET || "100");
const MAX_EXPOSURE       = parseInt(process.env.MAX_EXPOSURE || "2000");

function getKalshiHeaders(method, path) {
  const timestamp = Date.now().toString();
  const message = timestamp + method.toUpperCase() + path;
  const sign = crypto.createSign("SHA256");
  sign.update(message);
  sign.end();
  const signature = sign.sign(
    { key: KALSHI_PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_PSS_PADDING },
    "base64"
  );
  return {
    "Content-Type":            "application/json",
    "KALSHI-ACCESS-KEY":       KALSHI_KEY_ID,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signature,
  };
}

async function safeRequest(method, fullUrl, data = null) {
  safetyCheck(fullUrl);
  const urlPath = fullUrl.replace(BASE_URL, "");
  const headers = getKalshiHeaders(method, "/trade-api/v2" + urlPath);
  const config = { method, url: fullUrl, headers };
  if (data) config.data = data;
  const response = await axios(config);
  return response.data;
}

function requireAuth(req, res, next) {
  const token = req.headers["x-agent-secret"] || req.query.secret;
  if (!token || token !== AGENT_SECRET) {
    log(`🚨 Unauthorized access attempt from ${req.ip}`);
    return res.status(401).json({ error: "Unauthorized." });
  }
  next();
}

let agentRunning  = false;
let agentInterval = null;
let pingInterval  = null;
let tradeLog      = [];
let opportunities = [];

// ── Opportunity History for analysis ─────────────────────────
let opportunityHistory = [];

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
  const entry = { time: new Date().toISOString(), msg, type };
  tradeLog.unshift(entry);
  if (tradeLog.length > 200) tradeLog.pop();
  console.log(`[${entry.time}] ${msg}`);
}

function startKeepAlive() {
  const appUrl = process.env.RENDER_EXTERNAL_URL;
  if (!appUrl) { log("⚠️ RENDER_EXTERNAL_URL not set — keep alive disabled", "error"); return; }
  pingInterval = setInterval(async () => {
    try { await axios.get(`${appUrl}/health`); log("💓 Keep alive ping sent", "info"); }
    catch (e) { log(`⚠️ Keep alive ping failed: ${e.message}`, "error"); }
  }, 10 * 60 * 1000);
  log("💓 Keep alive started — pinging every 10 minutes");
}

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

async function getTotalExposure() {
  const positions = await getPositions();
  return positions.reduce((sum, p) => sum + Math.abs(p.market_exposure || 0), 0);
}

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
      closeDate:   market.close_time || null,
      // Paper trade tracking
      wouldHaveSpent:  totalCost,
      wouldHaveProfit: profitCents,
    };
  }
  return null;
}

async function scanForArbitrage() {
  log("🔍 Scanning Kalshi markets for arbitrage...", "scan");
  stats.scans++;
  stats.lastScan = new Date().toISOString();
  try {
    const markets = await getAllMarkets();
    log(`📊 Scanning ${markets.length} open markets...`);

    const found = [];
    for (const market of markets) {
      const arb = detectArbitrage(market);
      if (arb) {
        found.push(arb);
        stats.opportunitiesFound++;

        // Save to history for later analysis
        opportunityHistory.unshift(arb);
        if (opportunityHistory.length > 500) opportunityHistory.pop();

        log(`📋 OPPORTUNITY LOGGED: ${arb.title} | Margin: ${arb.margin} | Would profit: ${arb.profitCents}¢`, "opportunity");
      }
    }

    opportunities = found.sort((a, b) => b.marginRaw - a.marginRaw);

    if (found.length === 0) {
      log("⏸ No arbitrage opportunities found this scan.");
    } else {
      log(`✅ Found ${found.length} opportunities logged for analysis. Top: ${found[0]?.title} (${found[0]?.margin})`);
    }

  } catch (err) {
    stats.errors++;
    log(`⚠️ Scan error: ${err.message}`, "error");
  }
}

app.get("/", (req, res) => res.send("🤖 Kalshi Arbitrage Agent (Paper Mode) is running!"));
app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

app.get("/debug-secret", (req, res) => {
  res.json({
    agent_secret_set: !!process.env.AGENT_SECRET,
    agent_secret_length: (process.env.AGENT_SECRET || "").length,
    query_secret: req.query.secret,
    match: req.query.secret === process.env.AGENT_SECRET
  });
});

app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "kalshi_dashboard.html")));

app.get("/privacy", (req, res) => res.json({
  accesses:       ["Public market prices", "Portfolio balance", "Open positions", "Place YES/NO orders"],
  never_accesses: ["SSN", "Bank info", "Personal identity", "Password", "Withdrawals", "Deposits"],
  max_bet_cents: MAX_BET, min_margin: MIN_MARGIN, max_exposure: MAX_EXPOSURE,
}));

app.get("/status", requireAuth, async (req, res) => {
  let balance = null, positions = [], exposure = 0;
  try { balance = await getBalance(); } catch (e) { log(`⚠️ Balance fetch failed: ${e.message}`, "error"); }
  try { positions = await getPositions(); } catch (e) { log(`⚠️ Positions fetch failed: ${e.message}`, "error"); }
  try { exposure = await getTotalExposure(); } catch (e) {}
  res.json({ agentRunning, stats, balance, positions, exposure, opportunities: opportunities.slice(0, 10), log: tradeLog.slice(0, 20) });
});

// ── Analysis endpoint — review all logged opportunities ───────
app.get("/analysis", requireAuth, (req, res) => {
  const totalOpps     = opportunityHistory.length;
  const totalWouldHaveSpent  = opportunityHistory.reduce((s, o) => s + o.wouldHaveSpent, 0);
  const totalWouldHaveProfit = opportunityHistory.reduce((s, o) => s + o.wouldHaveProfit, 0);
  const byMargin = [...opportunityHistory].sort((a, b) => b.marginRaw - a.marginRaw);
  res.json({
    summary: {
      totalOpportunitiesFound: totalOpps,
      totalWouldHaveSpentCents:  totalWouldHaveSpent,
      totalWouldHaveProfitCents: totalWouldHaveProfit,
      totalWouldHaveProfitDollars: (totalWouldHaveProfit / 100).toFixed(2),
      averageMargin: totalOpps ? (opportunityHistory.reduce((s, o) => s + o.marginRaw, 0) / totalOpps * 100).toFixed(2) + "%" : "N/A",
    },
    topOpportunities: byMargin.slice(0, 20),
    allOpportunities: opportunityHistory,
  });
});

app.post("/agent/start", requireAuth, (req, res) => {
  if (agentRunning) return res.json({ msg: "Agent already running" });
  agentRunning = true;
  scanForArbitrage();
  agentInterval = setInterval(scanForArbitrage, 60 * 1000);
  startKeepAlive();
  log("▶ Paper trading agent started — scanning every 60 seconds, logging opportunities only");
  res.json({ msg: "Agent started in paper mode" });
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
  try { res.json(await getBalance()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/positions", requireAuth, async (req, res) => {
  try { res.json(await getPositions()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use((req, res) => res.status(404).json({ error: "Route not found" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Kalshi Arbitrage Agent (Paper Mode) running on port ${PORT}`);
  startKeepAlive();
});
