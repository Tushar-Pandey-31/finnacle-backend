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

router.post("/trades/buy", authMiddleware, async (req, res) => {
  try {
    const { symbol, quantity, priceCents } = req.body || {};
    const qty = Number(quantity);
    if (!symbol || !qty || qty <= 0) return res.status(400).json({ error: "symbol and positive quantity required" });

    // If priceCents not supplied, reject for now (no live pricing in this route)
    if (priceCents == null) return res.status(400).json({ error: "priceCents required" });
    const px = toCentsOrThrow(priceCents);
    const costCents = Math.round(px * qty);

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: req.userId }, select: { walletBalanceCents: true } });
      if (!user) throw new Error("User not found");
      if (user.walletBalanceCents < costCents) {
        return { error: "Insufficient funds" };
      }

      const portfolio = await getOrCreateDefaultPortfolio(tx, req.userId);
      const existing = await tx.holding.findFirst({ where: { portfolioId: portfolio.id, symbol } });

      let newAvg = px;
      let newQty = qty;
      if (existing) {
        const res = computeBuyAveragePriceCents(existing.avgPriceCents, existing.quantity, px, qty);
        newAvg = res.newAvgPriceCents;
        newQty = res.newQuantity;
        await tx.holding.update({ where: { id: existing.id }, data: { quantity: newQty, avgPriceCents: newAvg } });
      } else {
        await tx.holding.create({ data: { portfolioId: portfolio.id, symbol, quantity: qty, avgPriceCents: px } });
      }

      const updatedUser = await tx.user.update({
        where: { id: req.userId },
        data: { walletBalanceCents: { decrement: costCents } },
        select: { walletBalanceCents: true },
      });

      const positions = await tx.holding.findMany({ where: { portfolioId: portfolio.id }, select: { symbol: true, quantity: true, avgPriceCents: true } });
      return { walletBalanceCents: updatedUser.walletBalanceCents, positions };
    });

    if (result && result.error) return res.status(400).json({ error: result.error });
    return res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/trades/sell", authMiddleware, async (req, res) => {
  try {
    const { symbol, quantity, priceCents } = req.body || {};
    const qty = Number(quantity);
    if (!symbol || !qty || qty <= 0) return res.status(400).json({ error: "symbol and positive quantity required" });
    if (priceCents == null) return res.status(400).json({ error: "priceCents required" });
    const px = toCentsOrThrow(priceCents);
    const proceedsCents = Math.round(px * qty);

    const result = await prisma.$transaction(async (tx) => {
      const portfolio = await getOrCreateDefaultPortfolio(tx, req.userId);
      const existing = await tx.holding.findFirst({ where: { portfolioId: portfolio.id, symbol } });
      if (!existing || existing.quantity < qty) {
        return { error: "Insufficient quantity" };
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

      const positions = await tx.holding.findMany({ where: { portfolioId: portfolio.id }, select: { symbol: true, quantity: true, avgPriceCents: true } });
      return { walletBalanceCents: updatedUser.walletBalanceCents, positions, realizedPnlCents: updatedUser.realizedPnlCents };
    });

    if (result && result.error) return res.status(400).json({ error: result.error });
    return res.json(result);
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
    const positions = await prisma.holding.findMany({ where: { portfolioId: portfolio.id }, select: { symbol: true, quantity: true, avgPriceCents: true } });

    // Enrich with lastPriceCents from Finnhub if configured
    let enriched = positions.map((p) => ({ ...p, lastPriceCents: null }));
    const token = process.env.FINNHUB_API_KEY;
    if (token && enriched.length) {
      const uniqueSymbols = Array.from(new Set(enriched.map((p) => p.symbol)));
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
      enriched = enriched.map((p) => ({ ...p, lastPriceCents: symToLast[p.symbol] ?? null }));
    }

    res.json({ walletBalanceCents: user.walletBalanceCents, positions: enriched, realizedPnlCents: user.realizedPnlCents });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

