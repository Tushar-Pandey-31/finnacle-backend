import express from "express";
import jwt from "jsonwebtoken";
import axios from "axios";
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

function normalizeHoldings(inputHoldings) {
  if (!Array.isArray(inputHoldings)) return [];
  return inputHoldings
    .filter((h) => h && typeof h.symbol === "string" && h.symbol.trim().length > 0)
    .map((h) => ({ symbol: String(h.symbol).trim().toUpperCase(), quantity: isFinite(h.quantity) ? Number(h.quantity) : undefined }));
}

router.post("/ai/analyze-portfolio", authMiddleware, async (req, res) => {
  try {
    const { portfolioId, holdings } = req.body || {};

    let portfolioPayload = [];

    // Correctly check for a valid portfolioId before processing
    if (portfolioId != null && !isNaN(Number(portfolioId))) {
      const id = parseInt(portfolioId);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid portfolioId" });
      }
      // Ensure portfolio belongs to the authenticated user
      const portfolio = await prisma.portfolio.findFirst({
        where: { id, userId: req.userId },
        select: { id: true },
      });
      if (!portfolio) return res.status(404).json({ error: "Portfolio not found" });

      const rows = await prisma.holding.findMany({
        where: { portfolioId: id },
        select: { symbol: true, quantity: true },
        orderBy: { id: "asc" },
      });
      portfolioPayload = normalizeHoldings(rows);
    } else if (Array.isArray(holdings)) {
      portfolioPayload = normalizeHoldings(holdings);
    } else {
      return res.status(400).json({ error: "Provide portfolioId or holdings[]" });
    }

    if (portfolioPayload.length === 0) {
      return res.status(400).json({ error: "Empty portfolio" });
    }

    const aiUrl = process.env.AI_SERVICE_URL;
    const aiKey = process.env.AI_SERVICE_KEY;
    if (!aiUrl || !aiKey) {
      return res.status(500).json({ error: "AI service not configured" });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    let aiResponse;
    try {
      aiResponse = await axios.post(
        `${String(aiUrl).replace(/\/$/, "")}/analyze-portfolio`,
        { portfolio: portfolioPayload },
        {
          headers: { "x-api-key": aiKey, "Content-Type": "application/json" },
          signal: controller.signal,
          validateStatus: (s) => s >= 200 && s < 500,
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    if (aiResponse.status >= 400) {
      const msg = aiResponse.data?.error || `AI service error (${aiResponse.status})`;
      const code = aiResponse.status === 400 ? 400 : 502;
      return res.status(code).json({ error: msg });
    }

    const analysis = aiResponse.data?.analysis;
    if (!analysis || typeof analysis !== "string") {
      return res.status(502).json({ error: "Invalid AI response" });
    }

    const result = { analysis };
    if (aiResponse.data?.prices && typeof aiResponse.data.prices === "object") {
      result.prices = aiResponse.data.prices;
    }

    return res.json(result);
  } catch (e) {
    if (e.name === "AbortError") {
      return res.status(502).json({ error: "AI service timeout" });
    }
    return res.status(500).json({ error: e.message || "Server error" });
  }
});

export default router;