import { Topic } from "../models/Topic";
import { RevisionRecord } from "../models/RevisionRecord";
import { connectDatabase } from "@/config/database";

const SAMPLE_USER_ID = "test-user-530";

async function seedTopics() {
  const topics = [
    {
      userId: SAMPLE_USER_ID,
      topicName: "Introduction to TypeScript",
      subjectName: "Programming",
      description: "Basic TypeScript concepts and syntax",
      dateStudied: new Date("2024-01-01"),
      revisionDate: new Date("2024-01-02"),
      lastRevised: null,
      eFactor: 2.5,
      repetitionNumber: 0,
      interval: 1,
      files: [],
      mindMap: null,
      mindMapGeneratedAt: null,
    },
    {
      userId: SAMPLE_USER_ID,
      topicName: "React Hooks",
      subjectName: "Programming",
      description: "useState, useEffect, and custom hooks",
      dateStudied: new Date("2024-01-05"),
      revisionDate: new Date("2024-01-06"),
      lastRevised: null,
      eFactor: 2.5,
      repetitionNumber: 0,
      interval: 1,
      files: [],
      mindMap: null,
      mindMapGeneratedAt: null,
    },
  ];

  const insertedTopics = await Topic.insertMany(topics);
  console.log(`✓ Inserted ${insertedTopics.length} topics`);
  return insertedTopics;
}

async function seedRevisions(topics: any[]) {
  const revisions = topics.map((topic) => ({
    userId: SAMPLE_USER_ID,
    topicId: topic._id,
    revisionDate: new Date(),
    userQuality: 4,
    llmQuality: 4,
    finalQuality: 4,
    newEFactor: 2.5,
    newInterval: 1,
    nextRevisionDate: new Date(Date.now() + 86400000),
  }));

  const insertedRevisions = await RevisionRecord.insertMany(revisions);
  console.log(`✓ Inserted ${insertedRevisions.length} revision records`);
}

async function main() {
  try {
    await connectDatabase();
    console.log("Connected to database");

    await Topic.deleteMany({ userId: SAMPLE_USER_ID });
    await RevisionRecord.deleteMany({ userId: SAMPLE_USER_ID });
    console.log("✓ Cleared existing test data");

    const topics = await seedTopics();
    await seedRevisions(topics);

    console.log("✓ Seed completed successfully");
    process.exit(0);
  } catch (error) {
    console.error("Seed failed:", error);
    process.exit(1);
  }
}

main();
