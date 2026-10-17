/**
 * The bank's answer keys and the retired list never leave the database on an
 * ordinary topic query (KTD6).
 */
import { useMongoMemoryServer } from "../test/mongo";
import { Topic } from "@models/Topic";
import { toQuestionBankView } from "@services/questionBankView";

useMongoMemoryServer();

const question = { id: "q1", key: "what is 2 + 2", type: "fill_blank" as const, prompt: "2 + 2 = ____", answer: "4", alternatives: ["four"] };

async function topicWithBank() {
  return Topic.create({
    userId: "user-1",
    topicName: "Arithmetic",
    subjectName: "Maths",
    dateStudied: new Date(),
    revisionDate: new Date(),
    questionBank: { state: "ready", questions: [question], usableCount: 1 },
    retiredQuestions: [{ key: "old", text: "Old?", retiredAt: new Date() }],
  });
}

describe("Topic question bank fields", () => {
  it("reads a new topic's bank as none with no questions", async () => {
    const topic = await Topic.create({ userId: "user-1", topicName: "T", subjectName: "S", dateStudied: new Date(), revisionDate: new Date() });
    const lean = await Topic.findById(topic._id).lean();

    expect(toQuestionBankView(lean!.questionBank)).toEqual({ state: "none", usableCount: 0, rebuilding: false });
    expect(lean!.lastQuality).toBeNull();
  });

  it("leaves questions and the retired list out of default and lean queries", async () => {
    const { _id } = await topicWithBank();

    const lean = await Topic.findById(_id).lean();
    const doc = await Topic.findById(_id);
    const json = JSON.stringify(doc!.toJSON());

    expect(lean!.questionBank).not.toHaveProperty("questions");
    expect(lean).not.toHaveProperty("retiredQuestions");
    expect(json).not.toContain("2 + 2");
    expect(json).not.toContain("Old?");
    expect(lean!.questionBank.usableCount).toBe(1);
  });

  it("returns them only when explicitly selected", async () => {
    const { _id } = await topicWithBank();

    const lean = await Topic.findById(_id).select("+questionBank.questions +retiredQuestions").lean();

    expect(lean!.questionBank.questions).toEqual([question]);
    expect(lean!.retiredQuestions).toHaveLength(1);
  });

  it("keeps the questions when a document loaded without them is saved", async () => {
    const { _id } = await topicWithBank();

    const doc = await Topic.findById(_id);
    doc!.topicName = "Renamed";
    doc!.questionBank.state = "queued";
    await doc!.save();

    const after = await Topic.findById(_id).select("+questionBank.questions +retiredQuestions").lean();
    expect(after!.questionBank.questions).toHaveLength(1);
    expect(after!.retiredQuestions).toHaveLength(1);
    expect(after!.questionBank.state).toBe("queued");
  });

  it("reads a topic saved before banks existed as state none", async () => {
    const { insertedId } = await Topic.collection.insertOne({ userId: "user-1", topicName: "Legacy", subjectName: "S", dateStudied: new Date(), revisionDate: new Date() });
    const lean = await Topic.findById(insertedId).lean();

    expect(toQuestionBankView(lean!.questionBank)).toEqual({ state: "none", usableCount: 0, rebuilding: false });
  });
});

describe("saving a topic loaded before a concurrent bank write", () => {
  const legacy = { userId: "user-1", topicName: "Legacy", subjectName: "S", dateStudied: new Date(), revisionDate: new Date() };

  it("keeps a bank build that landed after the load", async () => {
    const claimedAt = new Date("2026-10-01T10:00:00.000Z");
    const { insertedId } = await Topic.collection.insertOne({ ...legacy, questionBank: { state: "building", claimedAt } });

    const doc = await Topic.findById(insertedId);
    await Topic.collection.updateOne({ _id: insertedId }, { $set: { "questionBank.usableCount": 7, "questionBank.state": "ready" } });
    doc!.topicName = "Renamed";
    await doc!.save();

    const raw = await Topic.collection.findOne({ _id: insertedId });
    expect(raw!.topicName).toBe("Renamed");
    expect(raw!.questionBank).toMatchObject({ state: "ready", usableCount: 7 });
    expect(raw!.questionBank).not.toHaveProperty("attempts");
  });

  it("keeps a bank claim on a topic saved before banks existed", async () => {
    const { insertedId } = await Topic.collection.insertOne({ ...legacy });

    const doc = await Topic.findById(insertedId);
    await Topic.collection.updateOne({ _id: insertedId }, { $set: { "questionBank.state": "building" } });
    doc!.topicName = "Renamed";
    await doc!.save();

    const raw = await Topic.collection.findOne({ _id: insertedId });
    expect(raw!.topicName).toBe("Renamed");
    expect(raw!.questionBank.state).toBe("building");
  });
});

describe("toQuestionBankView", () => {
  it.each([
    [{ state: "queued", usableCount: 4 }, true],
    [{ state: "building", usableCount: 1 }, true],
    [{ state: "building", usableCount: 0 }, false],
    [{ state: "ready", usableCount: 9 }, false],
    [{ state: "failed", usableCount: 9 }, false],
  ] as const)("marks %p rebuilding=%p", (bank, rebuilding) => {
    expect(toQuestionBankView(bank).rebuilding).toBe(rebuilding);
  });
});
