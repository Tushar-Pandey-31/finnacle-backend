import express from "express";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";

const router = express.Router();
const prisma = new PrismaClient();

function authOptional(req, _res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.userId = decoded.id;
    }
  } catch {}
  next();
}

function authRequired(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: "Unauthorized" });
  next();
}

async function getRankForUser(userId) {
  // Rank = 1 + count of users with strictly higher balance
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { walletBalanceCents: true } });
  if (!user) return null;
  const higher = await prisma.user.count({ where: { walletBalanceCents: { gt: user.walletBalanceCents } } });
  return { rank: higher + 1, walletBalanceCents: user.walletBalanceCents };
}

router.get("/leaderboard", authOptional, async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    // Use window function for rank; fall back to deterministic ordering when ties exist
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id as "userId", COALESCE(name, email) as name, "walletBalanceCents",
              RANK() OVER (ORDER BY "walletBalanceCents" DESC, id ASC) AS rank
       FROM "User"
       ORDER BY "walletBalanceCents" DESC, id ASC
       LIMIT $1 OFFSET $2`,
      Number(limit), Number(offset)
    );

    let me = null;
    if (req.userId) me = await getRankForUser(req.userId);

    res.json({ users: rows, me });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/leaderboard/me", authRequired, async (req, res) => {
  try {
    const me = await getRankForUser(req.userId);
    if (!me) return res.status(404).json({ error: "User not found" });
    res.json(me);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

