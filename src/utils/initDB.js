import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function initializeDatabase() {
  try {
    // Check if columns exist
    await prisma.user.findFirst({
      select: { emailVerified: true, passwordResetToken: true, walletBalanceCents: true }
    });
    console.log('✅ Database schema is ready');
    return true;
  } catch (error) {
    if (error.code === 'P2022') {
      console.log('🔄 Adding email verification columns...');
      
      // Add missing columns
      await prisma.$executeRaw`
        ALTER TABLE "User" 
        ADD COLUMN IF NOT EXISTS "emailVerified" BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS "emailVerificationToken" TEXT,
        ADD COLUMN IF NOT EXISTS "emailVerificationExpires" TIMESTAMP,
        ADD COLUMN IF NOT EXISTS "passwordResetToken" TEXT,
        ADD COLUMN IF NOT EXISTS "passwordResetExpires" TIMESTAMP,
        ADD COLUMN IF NOT EXISTS "name" TEXT NULL,
        ADD COLUMN IF NOT EXISTS "walletBalanceCents" INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "initialWalletGrantedAt" TIMESTAMP NULL,
        ADD COLUMN IF NOT EXISTS "realizedPnlCents" INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW();
      `;
      
      await prisma.$executeRaw`
        CREATE UNIQUE INDEX IF NOT EXISTS "User_emailVerificationToken_key" 
        ON "User"("emailVerificationToken");
      `;

      await prisma.$executeRaw`
        CREATE UNIQUE INDEX IF NOT EXISTS "User_passwordResetToken_key" 
        ON "User"("passwordResetToken");
      `;

      await prisma.$executeRaw`
        DO $$ BEGIN
          CREATE INDEX "idx_user_wallet_balance" ON "User"("walletBalanceCents" DESC);
        EXCEPTION WHEN duplicate_table THEN NULL; END $$;
      `;

      // Backfill initial grant for legacy users missing it
      await prisma.$executeRaw`
        UPDATE "User"
        SET "walletBalanceCents" = 1000000,
            "initialWalletGrantedAt" = NOW()
        WHERE ("walletBalanceCents" IS NULL OR "walletBalanceCents" = 0)
          AND "initialWalletGrantedAt" IS NULL;
      `;

      // Backfill initial grant for legacy users missing it
      await prisma.$executeRaw`
        UPDATE "User"
        SET "walletBalanceCents" = 1000000,
            "initialWalletGrantedAt" = NOW()
        WHERE ("walletBalanceCents" IS NULL OR "walletBalanceCents" = 0)
          AND "initialWalletGrantedAt" IS NULL;
      `;
      
      console.log('✅ Email verification columns added');
      // Fallthrough to ensure quiz-related tables exist as well
    }
    // Ensure Quiz and MoneyTransaction structures exist (idempotent)
    try {
      console.log('🔄 Ensuring quiz and wallet audit tables exist...');
      await prisma.$executeRaw`
        DO $$ BEGIN
          CREATE TYPE "MoneyTransactionReason" AS ENUM ('INITIAL_GRANT', 'QUIZ_CORRECT_ANSWER');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      `;

      await prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS "QuizQuestion" (
          id SERIAL PRIMARY KEY,
          prompt TEXT NOT NULL,
          options TEXT[] NOT NULL,
          "correctOptionIndex" INTEGER NOT NULL,
          category TEXT,
          difficulty TEXT,
          "isActive" BOOLEAN NOT NULL DEFAULT true,
          "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
        );
      `;

      await prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS "DailyQuizAssignment" (
          id SERIAL PRIMARY KEY,
          "userId" INTEGER NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
          "dateUTC" DATE NOT NULL,
          "questionIds" INTEGER[] NOT NULL,
          attempts JSONB,
          "correctCount" INTEGER NOT NULL DEFAULT 0,
          "attemptedCount" INTEGER NOT NULL DEFAULT 0,
          "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
          CONSTRAINT daily_quiz_unique UNIQUE ("userId", "dateUTC")
        );
      `;

      await prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS "MoneyTransaction" (
          id SERIAL PRIMARY KEY,
          "userId" INTEGER NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
          "amountCents" INTEGER NOT NULL,
          reason "MoneyTransactionReason" NOT NULL,
          "relatedId" TEXT,
          "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
        );
      `;

      await prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS money_tx_user_idx ON "MoneyTransaction"("userId");
      `;

      await prisma.$executeRaw`
        DO $$ BEGIN
          CREATE UNIQUE INDEX money_tx_business_key ON "MoneyTransaction"("userId", reason, "relatedId");
        EXCEPTION WHEN duplicate_table THEN NULL; END $$;
      `;

      console.log('✅ Quiz and wallet audit tables are ensured');
      return true;
    } catch (ddlError) {
      console.error('Failed to ensure quiz tables:', ddlError);
      throw ddlError;
    }
  }
}