import express from "express";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";

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

// GET /watchlist
router.get("/watchlist", authMiddleware, async (req, res) => {
  const items = await prisma.userWatchlist.findMany({
    where: { userId: req.userId },
    select: { marketType: true, symbol: true },
    orderBy: [{ marketType: "asc" }, { symbol: "asc" }],
  });
  res.json({ items });
});

// POST /watchlist/add { marketType, symbol }
router.post("/watchlist/add", authMiddleware, async (req, res) => {
  try {
    const { marketType, symbol } = req.body || {};
    if (!marketType || !symbol) return res.status(400).json({ error: "marketType and symbol required" });
    const created = await prisma.userWatchlist.upsert({
      where: { userId_marketType_symbol: { userId: req.userId, marketType, symbol } },
      create: { userId: req.userId, marketType, symbol },
      update: {},
      select: { marketType: true, symbol: true },
    });
    res.json({ item: created });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /watchlist/remove { marketType, symbol }
router.delete("/watchlist/remove", authMiddleware, async (req, res) => {
  try {
    const { marketType, symbol } = req.body || {};
    if (!marketType || !symbol) return res.status(400).json({ error: "marketType and symbol required" });
    await prisma.userWatchlist.delete({
      where: { userId_marketType_symbol: { userId: req.userId, marketType, symbol } },
    });
    res.json({ ok: true });
  } catch (e) {
    // If not found, still respond ok to keep idempotent UX
    if (e.code === "P2025") return res.json({ ok: true });
    res.status(500).json({ error: e.message });
  }
});

export default router;