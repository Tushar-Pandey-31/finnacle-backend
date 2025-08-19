import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function initializeDatabase() {
  try {
    // Check if columns exist
    await prisma.user.findFirst({
      select: { emailVerified: true, passwordResetToken: true }
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
        ADD COLUMN IF NOT EXISTS "passwordResetExpires" TIMESTAMP;
      `;
      
      await prisma.$executeRaw`
        CREATE UNIQUE INDEX IF NOT EXISTS "User_emailVerificationToken_key" 
        ON "User"("emailVerificationToken");
      `;

      await prisma.$executeRaw`
        CREATE UNIQUE INDEX IF NOT EXISTS "User_passwordResetToken_key" 
        ON "User"("passwordResetToken");
      `;
      
      console.log('✅ Email verification columns added');
      return true;
    }
    throw error;
  }
}