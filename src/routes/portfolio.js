import express from "express";
import jwt from "jsonwebtoken";
import axios from "axios";
import { PrismaClient } from "@prisma/client";

const router = express.Router();
const prisma = new PrismaClient();

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

router.post("/", authMiddleware, async (req, res) => {
  const { name } = req.body;
  const portfolio = await prisma.portfolio.create({
    data: { name, userId: req.userId },
  });
  res.json(portfolio);
});

router.post("/:portfolioId/add", authMiddleware, async (req, res) => {
  const { symbol, quantity } = req.body;
  const holding = await prisma.holding.create({
    data: { symbol, quantity, portfolioId: parseInt(req.params.portfolioId) },
  });
  res.json(holding);
});

router.get("/:portfolioId/holdings", authMiddleware, async (req, res) => {
  const holdings = await prisma.holding.findMany({
    where: { portfolioId: parseInt(req.params.portfolioId) },
  });

  const results = await Promise.all(
    holdings.map(async (h) => {
      const { data } = await axios.get(`https://finnhub.io/api/v1/quote`, {
        params: { symbol: h.symbol, token: process.env.FINNHUB_API_KEY },
      });
      return { ...h, price: data.c };
    })
  );

  res.json(results);
});

export default router;
