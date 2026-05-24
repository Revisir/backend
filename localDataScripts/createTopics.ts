import "dotenv/config";
import { connectDatabase } from "../src/config/database";
import { Topic } from "../src/models/Topic";
import { calculateNextReview } from "../src/services/sm2Algorithm";
import mongoose from "mongoose";
import { DateTime } from "luxon";

const USER_ID = "test-user-123";

const topics = [
  { topicName: "Binary Search Trees", subjectName: "Data Structures", description: "BST operations and traversals", revisionDate: DateTime.now().toUTC().plus({ days: 1 }) },
  { topicName: "TCP/IP Model", subjectName: "Computer Networks", description: "Layers and protocols", revisionDate: DateTime.now().toUTC() },
  { topicName: "Normalization", subjectName: "Databases", description: "1NF to BCNF", revisionDate: DateTime.now().toUTC() },
  { topicName: "React Hooks", subjectName: "Web Development", description: "useState, useEffect, custom hooks", revisionDate: DateTime.now().toUTC() },
  { topicName: "Big O Notation", subjectName: "Algorithms", description: "Time and space complexity analysis", revisionDate: DateTime.now().toUTC().minus({ days: 1 }) },
];

async function main() {
  await connectDatabase();

  //   const sm2Result = calculateNextReview({ eFactor: 2.5, repetitionNumber: 0, interval: 1, quality: 3 });

  for (const t of topics) {
    const topic = new Topic({
      userId: USER_ID,
      topicName: t.topicName,
      subjectName: t.subjectName,
      description: t.description,
      dateStudied: new Date(),
      revisionDate: t.revisionDate,
      lastRevised: null,
      eFactor: 2.5,
      repetitionNumber: 0,
      interval: 1,
      files: [],
    });
    await topic.save();
    console.log(`Created: ${topic.topicName} (${topic._id})`);
  }

  await mongoose.disconnect();
}

main().catch(console.error);
