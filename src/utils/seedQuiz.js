import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const sampleQuestions = [
  {
    prompt: "What is the capital of France?",
    options: ["Paris", "Lyon", "Marseille", "Toulouse"],
    correctOptionIndex: 0,
    category: "geography",
    difficulty: "easy",
  },
  {
    prompt: "2 + 2 = ?",
    options: ["3", "4"],
    correctOptionIndex: 1,
    category: "math",
    difficulty: "easy",
  },
  {
    prompt: "Which company created the iPhone?",
    options: ["Apple", "Google", "Samsung", "Microsoft"],
    correctOptionIndex: 0,
    category: "tech",
    difficulty: "easy",
  },
];

async function main() {
  let count = await prisma.quizQuestion.count();
  if (count >= 200) {
    console.log(`QuizQuestion already seeded: ${count}`);
    return;
  }
  const toInsert = [];
  // Expand sample set to reach at least 200 items
  for (let i = 0; i < 70; i++) {
    for (const base of sampleQuestions) {
      toInsert.push({
        prompt: `${base.prompt} [v${i + 1}]`,
        options: base.options,
        correctOptionIndex: base.correctOptionIndex,
        category: base.category,
        difficulty: base.difficulty,
      });
    }
  }
  // Cap at 210 to avoid runaway
  const batch = toInsert.slice(0, 210);
  if (batch.length) {
    await prisma.quizQuestion.createMany({ data: batch, skipDuplicates: true });
    count = await prisma.quizQuestion.count();
    console.log(`Seeded quiz questions. Total now: ${count}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
}).finally(async () => {
  await prisma.$disconnect();
});

