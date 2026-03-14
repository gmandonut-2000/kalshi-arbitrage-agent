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

function safetyCheck(url) {
  const BLOCKED_ENDPOINTS = ["/funding","/deposit","/withdraw","/bank","/transfer","/ach","/wire","/payment"];
  const lower = url.toLowerCase();
  for (const blocked of BLOCKED_ENDPOINTS) {
    if (lower.includes(blocked)) {
      throw new Error(`🚨 BLOCKED: Agent attempted to access forbidden endpoint: ${url}`);
    }
  }
}

async function safeRequest(method, url, data = null) {
  safetyCheck(url);
  const config = { method, url, headers: kalshiHeaders };
  if (data) config.data = data;
  const response = await axios(config);
  return response.data;
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: "Too many requests. Please slow down." },
});
app.use(limiter);

const KALSHI_KEY    = process.env.KALSHI_KEY;
const KALSHI_SECRET = process.env.KALSHI_SECRET;
const AGENT_SECRET  = process.env.AGENT_SECRET;
const BASE_URL      = "https://trading.kalshi.com/trade-api/v2";
const MIN_MARGIN    = parseFloat(process.env.MIN_MARGIN || "0.05");
const MAX_BET       = parseInt(process.env.MAX_BET || "100");
const MAX_EXPOSURE  = parseInt(process.env.MAX_EXPOSURE || "2000");

const kalshiHeaders = {
  "Authorization": `Bearer ${KALSHI_KEY}`,
  "Content-Type":  "application/json",
};

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
    if
