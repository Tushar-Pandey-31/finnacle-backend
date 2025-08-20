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

function getTodayUtcDateOnly() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  return new Date(Date.UTC(y, m, d));
}

async function sampleFiveActiveQuestionIds() {
  // Prefer SQL-level random for uniform sample
  const rows = await prisma.$queryRaw`SELECT id FROM "QuizQuestion" WHERE "isActive" = true ORDER BY RANDOM() LIMIT 5`;
  return rows.map((r) => r.id);
}

router.get("/quiz/today", authMiddleware, async (req, res) => {
  try {
    const dateUTC = getTodayUtcDateOnly();

    // Try find existing assignment
    let assignment = await prisma.dailyQuizAssignment.findUnique({
      where: { userId_dateUTC: { userId: req.userId, dateUTC } },
    });

    // Lazily create if not exists
    if (!assignment) {
      let questionIds = await sampleFiveActiveQuestionIds();
      if (questionIds.length < 5) {
        // Fallback: take whatever exists (could be <5 during early seeding)
        const fallback = await prisma.quizQuestion.findMany({
          where: { isActive: true },
          select: { id: true },
          take: 5,
        });
        questionIds = fallback.map((q) => q.id);
      }

      try {
        assignment = await prisma.dailyQuizAssignment.create({
          data: {
            userId: req.userId,
            dateUTC,
            questionIds,
            attempts: {},
          },
        });
      } catch (e) {
        // Handle race via unique(userId, dateUTC)
        if (e.code === "P2002") {
          assignment = await prisma.dailyQuizAssignment.findUnique({
            where: { userId_dateUTC: { userId: req.userId, dateUTC } },
          });
        } else {
          throw e;
        }
      }
    }

    const attempts = assignment.attempts && typeof assignment.attempts === 'object' ? assignment.attempts : {};
    const questions = await prisma.quizQuestion.findMany({
      where: { id: { in: assignment.questionIds } },
      select: { id: true, prompt: true, options: true },
    });
    const questionsOut = questions.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      options: q.options,
      alreadyAnswered: Boolean(attempts[String(q.id)]),
    }));

    const progress = {
      attemptedCount: assignment.attemptedCount,
      correctCount: assignment.correctCount,
      remaining: Math.max(0, 5 - assignment.attemptedCount),
    };

    res.json({ assignmentId: assignment.id, dateUTC: assignment.dateUTC, questions: questionsOut, progress });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/quiz/answer", authMiddleware, async (req, res) => {
  try {
    const { assignmentId, questionId, selectedIndex } = req.body || {};
    if (!assignmentId || !questionId || typeof selectedIndex !== "number") {
      return res.status(400).json({ error: "assignmentId, questionId and selectedIndex are required" });
    }

    const today = getTodayUtcDateOnly();
    const assignment = await prisma.dailyQuizAssignment.findUnique({ where: { id: Number(assignmentId) } });
    if (!assignment || assignment.userId !== req.userId) return res.status(403).json({ error: "Forbidden" });
    // Ensure it's for today
    if (assignment.dateUTC.toISOString().slice(0, 10) !== today.toISOString().slice(0, 10)) {
      return res.status(400).json({ error: "Assignment is not for today" });
    }
    if (!assignment.questionIds.includes(Number(questionId))) {
      return res.status(400).json({ error: "Question not part of assignment" });
    }
    const attempts = assignment.attempts && typeof assignment.attempts === 'object' ? assignment.attempts : {};
    if (attempts[String(questionId)]) {
      return res.status(409).json({ error: "Already answered" });
    }
    if (assignment.attemptedCount >= 5) {
      return res.status(400).json({ error: "Attempt limit reached" });
    }

    const question = await prisma.quizQuestion.findUnique({ where: { id: Number(questionId) } });
    if (!question || !question.isActive) return res.status(400).json({ error: "Invalid question" });

    const isCorrect = Number(selectedIndex) === question.correctOptionIndex;
    const businessKey = `${assignment.id}:${question.id}`;

    const result = await prisma.$transaction(async (tx) => {
      // Re-read inside tx to check answered flag
      const fresh = await tx.dailyQuizAssignment.findUnique({ where: { id: assignment.id } });
      const freshAttempts = fresh && fresh.attempts && typeof fresh.attempts === 'object' ? fresh.attempts : {};
      if (freshAttempts[String(question.id)]) {
        return { alreadyAnswered: true };
      }

      const newAttempts = { ...freshAttempts };
      newAttempts[String(question.id)] = {
        selectedIndex: Number(selectedIndex),
        isCorrect,
        answeredAt: new Date().toISOString(),
      };

      // Update assignment counts
      const updated = await tx.dailyQuizAssignment.update({
        where: { id: assignment.id },
        data: {
          attempts: newAttempts,
          attemptedCount: (fresh?.attemptedCount || 0) + 1,
          correctCount: (fresh?.correctCount || 0) + (isCorrect ? 1 : 0),
        },
      });

      let newWalletBalanceCents = undefined;
      if (isCorrect) {
        try {
          await tx.moneyTransaction.create({
            data: {
              userId: req.userId,
              amountCents: 50000,
              reason: "QUIZ_CORRECT_ANSWER",
              relatedId: businessKey,
            },
          });
          const user = await tx.user.update({
            where: { id: req.userId },
            data: { walletBalanceCents: { increment: 50000 } },
            select: { walletBalanceCents: true },
          });
          newWalletBalanceCents = user.walletBalanceCents;
        } catch (e) {
          // Unique constraint -> already credited
          if (e.code !== "P2002") throw e;
          const u = await tx.user.findUnique({ where: { id: req.userId }, select: { walletBalanceCents: true } });
          newWalletBalanceCents = u?.walletBalanceCents;
        }
      }

      return { updated, newWalletBalanceCents };
    });

    if (result && result.alreadyAnswered) {
      // No-op response with original result per spec
      const u = await prisma.user.findUnique({ where: { id: req.userId }, select: { walletBalanceCents: true } });
      return res.status(409).json({ error: "Already answered", isCorrect: attempts[String(questionId)]?.isCorrect ?? null, newWalletBalanceCents: u?.walletBalanceCents, attemptedCount: assignment.attemptedCount, correctCount: assignment.correctCount });
    }

    const updated = result && result.updated ? result.updated : assignment;
    const balance = result ? result.newWalletBalanceCents : undefined;
    return res.json({ isCorrect, newWalletBalanceCents: balance, attemptedCount: updated.attemptedCount, correctCount: updated.correctCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/quiz/progress", authMiddleware, async (req, res) => {
  try {
    const dateUTC = getTodayUtcDateOnly();
    const assignment = await prisma.dailyQuizAssignment.findUnique({
      where: { userId_dateUTC: { userId: req.userId, dateUTC } },
    });
    if (!assignment) {
      return res.json({ attemptedCount: 0, correctCount: 0, remaining: 5, questions: [] });
    }
    const attempts = assignment.attempts && typeof assignment.attempts === 'object' ? assignment.attempts : {};
    const questions = assignment.questionIds.map((qid) => ({ id: qid, alreadyAnswered: Boolean(attempts[String(qid)]) }));
    res.json({ attemptedCount: assignment.attemptedCount, correctCount: assignment.correctCount, remaining: Math.max(0, 5 - assignment.attemptedCount), questions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

