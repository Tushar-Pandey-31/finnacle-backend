import express from "express";
import jwt from "jsonwebtoken";
import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { computeBuyAveragePriceCents, computeSellRealizedPnlCents } from "../utils/tradeMath.js";

const router = express.Router();
const prisma = new PrismaClient();

function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

async function getOrCreateDefaultPortfolio(tx, userId) {
  let portfolio = await tx.portfolio.findFirst({ where: { userId } });
  if (!portfolio) {
    portfolio = await tx.portfolio.create({ data: { userId, name: "Default" } });
  }
  return portfolio;
}

function toCentsOrThrow(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value === "string" && value.trim() !== "" && !isNaN(Number(value))) return Math.round(Number(value));
  if (typeof fallback === "number") return Math.round(fallback);
  throw new Error("Invalid cents value");
}

async function resolvePriceCents(symbol, priceCents, price) {
  // Prefer priceCents if provided
  if (priceCents != null) {
    const cents = Number(priceCents);
    if (!Number.isFinite(cents) || cents <= 0) return { error: "INVALID_PRICE" };
    return { priceCents: Math.round(cents) };
  }
  // Next, accept price (USD float)
  if (price != null) {
    const usd = Number(price);
    if (!Number.isFinite(usd) || usd <= 0) return { error: "INVALID_PRICE" };
    return { priceCents: Math.round(usd * 100) };
  }
  // Finally, fetch from Finnhub as market price
  const token = process.env.FINNHUB_API_KEY;
  if (!token) return { error: "INVALID_PRICE" };
  try {
    const { data } = await axios.get("https://finnhub.io/api/v1/quote", { params: { symbol, token } });
    const last = typeof data?.c === 'number' ? Math.round(data.c * 100) : null;
    if (!last || last <= 0) return { error: "INVALID_PRICE" };
    return { priceCents: last };
  } catch {
    return { error: "INVALID_SYMBOL" };
  }
}

async function enrichPositionsWithLastPrices(positions) {
  const token = process.env.FINNHUB_API_KEY;
  if (!token || !positions?.length) return positions.map((p) => ({ ...p, lastPriceCents: null }));
  const uniqueSymbols = Array.from(new Set(positions.map((p) => p.symbol)));
  const quotes = await Promise.all(
    uniqueSymbols.map(async (sym) => {
      try {
        const { data } = await axios.get("https://finnhub.io/api/v1/quote", { params: { symbol: sym, token } });
        const last = typeof data?.c === 'number' ? Math.round(data.c * 100) : null;
        return [sym, last];
      } catch {
        return [sym, null];
      }
    })
  );
  const symToLast = Object.fromEntries(quotes);
  return positions.map((p) => ({ ...p, lastPriceCents: symToLast[p.symbol] ?? null }));
}

router.post("/trades/buy", authMiddleware, async (req, res) => {
  try {
    const { symbol, quantity, priceCents, price } = req.body || {};
    const sym = String(symbol || '').trim().toUpperCase();
    const qty = Number(quantity);
    if (!sym) return res.status(400).json({ error: "INVALID_SYMBOL" });
    if (!qty || qty <= 0) return res.status(400).json({ error: "INVALID_QUANTITY" });

    const pr = await resolvePriceCents(sym, priceCents, price);
    if (pr.error) return res.status(400).json({ error: pr.error });
    const px = pr.priceCents;
    const costCents = Math.round(px * qty);

    const result = await prisma.$transaction(async (tx) => {
      // Lock user row to prevent concurrent double-spend
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.userId} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: req.userId }, select: { walletBalanceCents: true } });
      if (!user) throw new Error("User not found");
      if (user.walletBalanceCents < costCents) {
        return { error: "INSUFFICIENT_FUNDS" };
      }

      const portfolio = await getOrCreateDefaultPortfolio(tx, req.userId);
      // Lock existing holding row if it exists
      const lockRow = await tx.$queryRaw`SELECT id FROM "Holding" WHERE "portfolioId"=${portfolio.id} AND symbol=${sym} FOR UPDATE`;
      const existing = Array.isArray(lockRow) && lockRow.length
        ? await tx.holding.findUnique({ where: { id: lockRow[0].id } })
        : await tx.holding.findFirst({ where: { portfolioId: portfolio.id, symbol: sym } });

      let newAvg = px;
      let newQty = qty;
      if (existing) {
        const res = computeBuyAveragePriceCents(existing.avgPriceCents, existing.quantity, px, qty);
        newAvg = res.newAvgPriceCents;
        newQty = res.newQuantity;
        await tx.holding.update({ where: { id: existing.id }, data: { quantity: newQty, avgPriceCents: newAvg } });
      } else {
        await tx.holding.create({ data: { portfolioId: portfolio.id, symbol: sym, quantity: qty, avgPriceCents: px } });
      }

      const updatedUser = await tx.user.update({
        where: { id: req.userId },
        data: { walletBalanceCents: { decrement: costCents } },
        select: { walletBalanceCents: true },
      });

      const positionsRaw = await tx.holding.findMany({ where: { portfolioId: portfolio.id }, select: { symbol: true, quantity: true, avgPriceCents: true } });
      const positions = positionsRaw.map((p) => ({
        symbol: p.symbol,
        quantity: p.quantity,
        avgPrice: Math.round(p.avgPriceCents) / 100,
        qty: p.quantity,
        avgPriceCents: p.avgPriceCents,
      }));
      return { walletBalanceCents: updatedUser.walletBalanceCents, positions };
    });

    if (result && result.error) return res.status(400).json({ error: result.error });
    const enriched = await enrichPositionsWithLastPrices(result.positions);
    return res.json({ walletBalanceCents: result.walletBalanceCents, positions: enriched, realizedPnlCents: (await prisma.user.findUnique({ where: { id: req.userId }, select: { realizedPnlCents: true } }))?.realizedPnlCents || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/trades/sell", authMiddleware, async (req, res) => {
  try {
    const { symbol, quantity, priceCents, price } = req.body || {};
    const sym = String(symbol || '').trim().toUpperCase();
    const qty = Number(quantity);
    if (!sym) return res.status(400).json({ error: "INVALID_SYMBOL" });
    if (!qty || qty <= 0) return res.status(400).json({ error: "INVALID_QUANTITY" });
    const pr = await resolvePriceCents(sym, priceCents, price);
    if (pr.error) return res.status(400).json({ error: pr.error });
    const px = pr.priceCents;
    const proceedsCents = Math.round(px * qty);

    const result = await prisma.$transaction(async (tx) => {
      // Lock user row
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.userId} FOR UPDATE`;
      const portfolio = await getOrCreateDefaultPortfolio(tx, req.userId);
      // Lock holding row
      const lockRow = await tx.$queryRaw`SELECT id FROM "Holding" WHERE "portfolioId"=${portfolio.id} AND symbol=${sym} FOR UPDATE`;
      const existing = Array.isArray(lockRow) && lockRow.length
        ? await tx.holding.findUnique({ where: { id: lockRow[0].id } })
        : await tx.holding.findFirst({ where: { portfolioId: portfolio.id, symbol: sym } });
      if (!existing || existing.quantity < qty) {
        return { error: "INSUFFICIENT_QUANTITY" };
      }

      // Realized PnL = (sell - avg) * qty
      const realized = computeSellRealizedPnlCents(existing.avgPriceCents, px, qty);

      const remainingQty = existing.quantity - qty;
      if (remainingQty <= 0) {
        await tx.holding.delete({ where: { id: existing.id } });
      } else {
        await tx.holding.update({ where: { id: existing.id }, data: { quantity: remainingQty } });
      }

      const updatedUser = await tx.user.update({
        where: { id: req.userId },
        data: {
          walletBalanceCents: { increment: proceedsCents },
          realizedPnlCents: { increment: realized },
        },
        select: { walletBalanceCents: true, realizedPnlCents: true },
      });

      const positionsRaw = await tx.holding.findMany({ where: { portfolioId: portfolio.id }, select: { symbol: true, quantity: true, avgPriceCents: true } });
      const positions = positionsRaw.map((p) => ({
        symbol: p.symbol,
        quantity: p.quantity,
        avgPrice: Math.round(p.avgPriceCents) / 100,
        qty: p.quantity,
        avgPriceCents: p.avgPriceCents,
      }));
      return { walletBalanceCents: updatedUser.walletBalanceCents, positions, realizedPnlCents: updatedUser.realizedPnlCents };
    });

    if (result && result.error) return res.status(400).json({ error: result.error });
    const enriched = await enrichPositionsWithLastPrices(result.positions);
    return res.json({ walletBalanceCents: result.walletBalanceCents, positions: enriched, realizedPnlCents: result.realizedPnlCents });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/portfolio/summary", authMiddleware, async (req, res) => {
  try {
    const [user, portfolio] = await Promise.all([
      prisma.user.findUnique({ where: { id: req.userId }, select: { walletBalanceCents: true, realizedPnlCents: true } }),
      prisma.portfolio.findFirst({ where: { userId: req.userId }, select: { id: true } }),
    ]);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!portfolio) return res.json({ walletBalanceCents: user.walletBalanceCents, positions: [], realizedPnlCents: user.realizedPnlCents });
    const positionsRaw = await prisma.holding.findMany({ where: { portfolioId: portfolio.id }, select: { symbol: true, quantity: true, avgPriceCents: true } });
    const positions = positionsRaw.map((p) => ({
      symbol: p.symbol,
      quantity: p.quantity,
      avgPrice: Math.round(p.avgPriceCents) / 100,
      qty: p.quantity,
      avgPriceCents: p.avgPriceCents,
    }));
    const enriched = await enrichPositionsWithLastPrices(positions);
    res.json({ walletBalanceCents: user.walletBalanceCents, positions: enriched, realizedPnlCents: user.realizedPnlCents });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

