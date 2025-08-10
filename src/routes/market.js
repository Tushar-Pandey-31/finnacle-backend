import express from "express";
import axios from "axios";

const router = express.Router();

function respondError(res, e) {
  const code = e?.response?.status || 500;
  return res.status(code).json({ error: e?.response?.data || e?.message || "Upstream error" });
}

// Finnhub - quote
router.get("/finnhub/quote", async (req, res) => {
  try {
    const { symbol } = req.query;
    if (!symbol) return res.status(400).json({ error: "Missing symbol" });
    const token = process.env.FINNHUB_API_KEY;
    if (!token) return res.status(500).json({ error: "FINNHUB_API_KEY missing" });
    const { data } = await axios.get("https://finnhub.io/api/v1/quote", {
      params: { symbol, token },
    });
    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=20");
    return res.json(data);
  } catch (e) {
    return respondError(res, e);
  }
});

// Finnhub - candles
router.get("/finnhub/candles", async (req, res) => {
  try {
    const { symbol, resolution = "D", from, to } = req.query;
    if (!symbol) return res.status(400).json({ error: "Missing symbol" });
    const token = process.env.FINNHUB_API_KEY;
    if (!token) return res.status(500).json({ error: "FINNHUB_API_KEY missing" });
    const { data } = await axios.get("https://finnhub.io/api/v1/stock/candle", {
      params: { symbol, resolution, from, to, token },
    });
    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=20");
    return res.json(data);
  } catch (e) {
    return respondError(res, e);
  }
});

// Finnhub - search symbols
router.get("/finnhub/search", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: "Missing q" });
    const token = process.env.FINNHUB_API_KEY;
    if (!token) return res.status(500).json({ error: "FINNHUB_API_KEY missing" });
    const { data } = await axios.get("https://finnhub.io/api/v1/search", {
      params: { q, token },
    });
    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=240");
    return res.json(data);
  } catch (e) {
    return respondError(res, e);
  }
});

// Finnhub - option chain (if enabled on plan)
router.get("/finnhub/options", async (req, res) => {
  try {
    const { symbol } = req.query;
    if (!symbol) return res.status(400).json({ error: "Missing symbol" });
    const token = process.env.FINNHUB_API_KEY;
    if (!token) return res.status(500).json({ error: "FINNHUB_API_KEY missing" });
    const { data } = await axios.get("https://finnhub.io/api/v1/stock/option/chain", {
      params: { symbol, token },
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
    return res.json(data);
  } catch (e) {
    return respondError(res, e);
  }
});

// Forex - quote
router.get("/forex/quote", async (req, res) => {
  try {
    const { pair } = req.query; // "EURUSD"
    if (!pair || String(pair).length !== 6) return res.status(400).json({ error: "Invalid pair" });
    const base = String(pair).slice(0, 3).toUpperCase();
    const quote = String(pair).slice(3).toUpperCase();
    const apiKey = process.env.FOREX_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "FOREX_API_KEY missing" });
    const { data } = await axios.get("https://api.forexrateapi.com/v1/latest", {
      params: { api_key: apiKey, base, currencies: quote },
    });
    res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=40");
    return res.json({ rate: data?.rates?.[quote] ?? null });
  } catch (e) {
    return respondError(res, e);
  }
});

// CoinMarketCap - crypto quote
router.get("/cmc/quote", async (req, res) => {
  try {
    const { symbol } = req.query;
    if (!symbol) return res.status(400).json({ error: "Missing symbol" });
    const apiKey = process.env.CMC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "CMC_API_KEY missing" });
    const { data } = await axios.get(
      "https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest",
      {
        params: { symbol },
        headers: { "X-CMC_PRO_API_KEY": apiKey },
      }
    );
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.json(data);
  } catch (e) {
    return respondError(res, e);
  }
});

// Indian Stock API - base URL via env INDIAN_STOCK_API_URL
router.get("/india/quote", async (req, res) => {
  try {
    const baseUrl = process.env.INDIAN_STOCK_API_URL; // e.g., https://stock.indianapi.in
    if (!baseUrl) return res.status(500).json({ error: "INDIAN_STOCK_API_URL missing" });
    const { symbol } = req.query;
    if (!symbol) return res.status(400).json({ error: "Missing symbol" });
    const { data } = await axios.get(`${baseUrl.replace(/\/$/, '')}/quote`, {
      params: { symbol },
    });
    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
    return res.json(data);
  } catch (e) {
    return respondError(res, e);
  }
});

export default router;