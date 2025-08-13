import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { body, validationResult } from "express-validator";
import { mailTransport } from "../config/nodemailer.js";

const router = express.Router();
const prisma = new PrismaClient();

router.post(
  "/register",
  [
    body("email").isEmail().normalizeEmail(),
    body("password").isString().isLength({ min: 8 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Invalid input", details: errors.array() });
      }

      const { email, password } = req.body;

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) return res.status(400).json({ error: "Email already registered" });

      const hashed = await bcrypt.hash(password, 10);
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      const user = await prisma.user.create({
        data: {
          email,
          password: hashed,
          emailVerified: false,
          emailVerificationToken: token,
          emailVerificationExpires: expiresAt,
        },
        select: { id: true, email: true, emailVerified: true },
      });

      const from = process.env.EMAIL_FROM_ADDRESS;
      const frontendUrl = process.env.FRONTEND_URL || "";
      const verifyUrl = `${String(frontendUrl).replace(/\/$/, "")}/verify-email?token=${token}`;

      try {
        await mailTransport.sendMail({
          from,
          to: email,
          subject: "Verify your Finnacle email",
          html: `<p>Welcome to Finnacle!</p><p>Please verify your email by clicking the link below:</p><p><a href="${verifyUrl}">Verify Email</a></p><p>This link expires in 1 hour.</p>`,
        });
      } catch (e) {
        // If email fails, we still keep the user record; client can retry verification
        console.warn("[mail] send failed:", e.message);
      }

      return res.status(201).json({ message: "Verification email sent" });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
);

router.post(
  "/verify-email",
  [body("token").isString().isLength({ min: 10 })],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Invalid token" });
      }

      const { token } = req.body;
      const user = await prisma.user.findFirst({
        where: {
          emailVerificationToken: token,
          emailVerificationExpires: { gt: new Date() },
        },
      });
      if (!user) return res.status(400).json({ error: "Invalid or expired token" });

      await prisma.user.update({
        where: { id: user.id },
        data: {
          emailVerified: true,
          emailVerificationToken: null,
          emailVerificationExpires: null,
        },
      });

      return res.json({ message: "Email verified" });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
);

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(400).json({ error: "Invalid email or password" });

    if (!user.emailVerified) {
      return res.status(403).json({ error: "Email not verified" });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: "Invalid email or password" });

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: "7d" });

    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stateless logout: client should discard token; server endpoint returns success for symmetry
router.post("/logout", async (req, res) => {
  return res.json({ message: "Logged out" });
});


router.get('/debug-db', async (req, res) => {
  try {
    // We are attempting a query that explicitly uses the new column
    await prisma.user.findFirst({
      select: {
        emailVerified: true,
      },
    });
    res.status(200).json({ status: 'OK', message: 'Database schema is up-to-date.' });
  } catch (e) {
    // This will catch the specific Prisma error and give us the details
    console.error('DEBUG DB ERROR:', e);
    res.status(500).json({ 
      status: 'ERROR', 
      message: 'Failed to query the new schema.',
      errorCode: e.code, // The specific Prisma error code
      errorMessage: e.message,
    });
  }
});

export default router;
