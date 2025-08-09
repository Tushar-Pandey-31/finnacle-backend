import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import morgan from "morgan";
import { PrismaClient } from "@prisma/client";

import authRoutes from "./routes/auth.js";
import portfolioRoutes from "./routes/portfolio.js";
import marketRoutes from "./routes/market.js";

dotenv.config();
const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

// Simple runtime env validation to catch misconfig early
const requiredEnvVars = ["DATABASE_URL", "JWT_SECRET", "FINNHUB_API_KEY"];
const missingEnvVars = requiredEnvVars.filter((key) => !process.env[key]);
if (missingEnvVars.length > 0) {
  console.warn(
    `Warning: missing environment variables -> ${missingEnvVars.join(
      ", "
    )}. The server will start but related features may fail.`
  );
}

app.get("/", (req, res) => {
  res.send("Finnacle Backend is running 🚀");
});

// Health endpoint to verify env presence from the platform (without leaking secrets)
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    env: {
      DATABASE_URL: Boolean(process.env.DATABASE_URL),
      JWT_SECRET: Boolean(process.env.JWT_SECRET),
      FINNHUB_API_KEY: Boolean(process.env.FINNHUB_API_KEY),
      node_env: process.env.NODE_ENV || null,
    },
  });
});

// Health endpoint to verify DB connectivity and basic prisma operation
app.get("/api/health/db", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const userCount = await prisma.user.count();
    res.json({ ok: true, userCount });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.use("/api/auth", authRoutes);
app.use("/api/portfolio", portfolioRoutes);
app.use("/api", marketRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
