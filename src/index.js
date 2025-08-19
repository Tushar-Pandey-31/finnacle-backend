import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import morgan from "morgan";
import { PrismaClient } from "@prisma/client";

import authRoutes from "./routes/auth.js";
import portfolioRoutes from "./routes/portfolio.js";
import marketRoutes from "./routes/market.js";
import watchlistRoutes from "./routes/watchlist.js";
import aiRoutes from "./routes/ai.js";

import { initializeDatabase } from './utils/initDB.js';

dotenv.config();

const app = express();
const prisma = new PrismaClient();

// Initialize database schema after env is available
await initializeDatabase();

// Centralized CORS configuration used for all requests, including preflights and errors
const allowedOrigins = [
  "https://finnacle-beta.vercel.app",
  "https://finnacle-ai-microservice.vercel.app",
  "http://localhost:3000",            // local dev
];

const corsOptions = {
  origin(origin, callback) {
    // Allow non-browser or same-origin requests with no Origin
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

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
app.use("/api", watchlistRoutes);
app.use("/api", aiRoutes);

// Global error handler: ensure CORS headers present on errors as well
app.use((err, req, res, next) => {
  try {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
  } catch {}
  console.error(err);
  const status = err.status || 500;
  const message = process.env.NODE_ENV === 'production'
    ? 'An unexpected server error occurred.'
    : err.message || 'Server error';
  res.status(status).json({ error: message });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
