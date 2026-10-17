/**
 * U5 — the normal quiz session API: start, answer, flag, complete.
 *
 * Runs against a real in-memory MongoDB so the conditional updates (grade
 * once, retire once, record once) are exercised for real.
 */
import request from "supertest";
import { useMongoMemoryServer, buildTestApp, TEST_USER_HEADER } from "../test/mongo";
import quizRoutes from "@routes/quizRoutes";
import { Topic, type IBankQuestion } from "@models/Topic";
import { QuizSession } from "@models/QuizSession";
import { RevisionRecord } from "@models/RevisionRecord";
import { recordRevision } from "@services/reviewRecorder";
import { learnerDayFromHeader } from "@services/learnerDay";
import { normalizeText } from "@services/questionText";
import { QUIZ } from "@config/questionBank";

useMongoMemoryServer();

const app = buildTestApp({ "/api/quiz": quizRoutes });

const USER = "user-1";
const OTHER_USER = "user-2";
const DAY_MS = 24 * 60 * 60_000;

function mcq(n: number): IBankQuestion {
  const prompt = `Which option is number ${n}?`;
  return { id: `mcq-${n}`, key: normalizeText(prompt), type: "mcq", prompt, options: [`Right ${n}`, `Wrong ${n}a`, `Wrong ${n}b`, `Wrong ${n}c`], answer: `Right ${n}` };
}

function blank(n: number): IBankQuestion {
  const prompt = `Blank number ${n} is ____.`;
  return { id: `blank-${n}`, key: normalizeText(prompt), type: "fill_blank", prompt, answer: `answer ${n}`, alternatives: [`alt ${n}`] };
}

/** `count` questions, alternating multiple choice and fill in the blank. */
function bank(count: number): IBankQuestion[] {
  return Array.from({ length: count }, (_, i) => (i % 2 === 0 ? mcq(i + 1) : blank(i + 1)));
}

async function createTopic(questions: IBankQuestion[], overrides: Record<string, unknown> = {}) {
  return Topic.create({
    userId: USER,
    topicName: "Photosynthesis",
    subjectName: "Biology",
    dateStudied: new Date(Date.now() - 10 * DAY_MS),
    revisionDate: new Date(Date.now() - DAY_MS),
    questionBank: { state: "ready", questions, usableCount: questions.length },
    ...overrides,
  });
}

async function storedTopic(topicId: unknown) {
  return (await Topic.findById(topicId).select("+questionBank.questions +retiredQuestions").lean())!;
}

function start(topicId: unknown, user = USER) {
  return request(app).post("/api/quiz/start").set(TEST_USER_HEADER, user).send({ topicId: String(topicId) });
}

function answer(sessionId: string, questionId: string, response: string, user = USER) {
  return request(app).post(`/api/quiz/${sessionId}/answer`).set(TEST_USER_HEADER, user).send({ questionId, response });
}

function flag(sessionId: string, questionId: string, user = USER) {
  return request(app).post(`/api/quiz/${sessionId}/flag`).set(TEST_USER_HEADER, user).send({ questionId });
}

function complete(sessionId: string, user = USER) {
  return request(app).post(`/api/quiz/${sessionId}/complete`).set(TEST_USER_HEADER, user).send();
}

interface QuizQuestionPayload {
  id: string;
  type: "mcq" | "fill_blank";
  prompt: string;
  options?: string[];
}

/** A response that is right (or deliberately wrong) for a bank question. */
function responseFor(question: IBankQuestion, correct: boolean): string {
  if (correct) return question.answer;
  return question.type === "mcq" ? question.options!.find((o) => o !== question.answer)! : "certainly not it";
}

/** Starts a quiz and answers every question, `pattern[i]` deciding whether question i is answered correctly. */
async function startAndAnswer(questions: IBankQuestion[], pattern: boolean[], topicId: unknown) {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const started = await start(topicId);
  expect(started.status).toBe(201);
  const drawn: QuizQuestionPayload[] = started.body.questions;
  for (const [i, q] of drawn.entries()) {
    const res = await answer(started.body.sessionId, q.id, responseFor(byId.get(q.id)!, pattern[i]));
    expect(res.status).toBe(200);
    expect(res.body.correct).toBe(pattern[i]);
  }
  return { sessionId: started.body.sessionId as string, drawn };
}

describe("POST /api/quiz/start", () => {
  it("draws five questions from a due topic with 15 ready questions and sends no answer fields", async () => {
    const questions = bank(15);
    const topic = await createTopic(questions);

    const res = await start(topic._id);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ topicId: topic._id.toString(), topicName: "Photosynthesis" });
    expect(typeof res.body.sessionId).toBe("string");
    const drawn: QuizQuestionPayload[] = res.body.questions;
    expect(drawn).toHaveLength(QUIZ.QUESTIONS_PER_QUIZ);
    expect(new Set(drawn.map((q) => q.id)).size).toBe(5);

    const byId = new Map(questions.map((q) => [q.id, q]));
    for (const q of drawn) {
      const source = byId.get(q.id)!;
      expect(source).toBeDefined();
      expect(q.type).toBe(source.type);
      expect(q.prompt).toBe(source.prompt);
      if (q.type === "mcq") {
        expect(Object.keys(q).sort()).toEqual(["id", "options", "prompt", "type"]);
        expect([...q.options!].sort()).toEqual([...source.options!].sort());
      } else {
        expect(Object.keys(q).sort()).toEqual(["id", "prompt", "type"]);
        expect(q.prompt).toContain("____");
      }
    }
    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/"answer"|"alternatives"|"key"|"correctAnswer"/);
    for (const q of questions) expect(json).not.toContain(`"alt ${q.id.split("-")[1]}"`);

    const session = await QuizSession.findById(res.body.sessionId).lean();
    expect(session).toMatchObject({ userId: USER, status: "active", result: null, topicName: "Photosynthesis" });
    expect(session!.questions.map((q) => q.id)).toEqual(drawn.map((q) => q.id));
    expect(session!.expiresAt.getTime() - session!.startedAt.getTime()).toBe(QUIZ.SESSION_TTL_MS);
  });

  it("draws at random and shuffles multiple-choice options", async () => {
    const questions = Array.from({ length: 15 }, (_, i) => mcq(i + 1));
    const topic = await createTopic(questions);

    const draws: QuizQuestionPayload[][] = [];
    for (let i = 0; i < 6; i++) draws.push((await start(topic._id)).body.questions);

    // Every bank question lists its answer first; across 30 drawn questions some must move.
    const answerFirst = draws.flat().filter((q) => q.options![0] === `Right ${q.id.split("-")[1]}`);
    expect(answerFirst.length).toBeLessThan(30);
    const drawnSets = new Set(draws.map((d) => d.map((q) => q.id).sort().join(",")));
    expect(drawnSets.size).toBeGreaterThan(1);
  });

  it("draws every remaining question when fewer than five remain", async () => {
    const topic = await createTopic(bank(4));
    const res = await start(topic._id);
    expect(res.status).toBe(201);
    expect(res.body.questions).toHaveLength(4);
  });

  it("covers AE2: three usable questions make a three-question quiz, and three correct records a 5", async () => {
    const questions = bank(3);
    const topic = await createTopic(questions);

    const { sessionId, drawn } = await startAndAnswer(questions, [true, true, true], topic._id);
    expect(drawn).toHaveLength(3);
    const res = await complete(sessionId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rating: 5, scored: 3, correct: 3 });
    expect(typeof res.body.nextRevisionDate).toBe("string");
    const record = await RevisionRecord.findOne({ topicId: topic._id }).lean();
    expect(record).toMatchObject({ method: "normal_quiz", userQuality: 5, finalQuality: 5, quizScored: 3, quizCorrect: 3 });
    expect(record!.sessionId!.toString()).toBe(sessionId);
    const after = await storedTopic(topic._id);
    expect(after.lastQuality).toBe(5);
    expect(after.revisionDate.toISOString()).toBe(res.body.nextRevisionDate);
  });

  it("refuses a bank with two usable questions with NOT_ENOUGH_QUESTIONS", async () => {
    const topic = await createTopic(bank(2));
    const res = await start(topic._id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("NOT_ENOUGH_QUESTIONS");
    expect(await QuizSession.countDocuments({})).toBe(0);
  });

  it("refuses a topic reviewed today with ALREADY_REVIEWED_TODAY, ahead of NOT_DUE", async () => {
    // A reviewed topic is rescheduled into the future, so it is also not due.
    const topic = await createTopic(bank(5), { lastRevised: new Date(), revisionDate: new Date(Date.now() + 3 * DAY_MS) });
    const res = await start(topic._id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_REVIEWED_TODAY");
  });

  it("refuses a topic not yet due with NOT_DUE, ahead of NOT_ENOUGH_QUESTIONS", async () => {
    const notDue = await createTopic(bank(5), { revisionDate: new Date(Date.now() + 3 * DAY_MS) });
    const notDueThin = await createTopic(bank(1), { revisionDate: new Date(Date.now() + 3 * DAY_MS) });

    for (const topic of [notDue, notDueThin]) {
      const res = await start(topic._id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("NOT_DUE");
    }
  });

  it("returns TOPIC_NOT_FOUND for another user's topic or an unknown id", async () => {
    const topic = await createTopic(bank(5));
    const otherUsers = await start(topic._id, OTHER_USER);
    const unknown = await start("0123456789abcdef01234567");

    for (const res of [otherUsers, unknown]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("TOPIC_NOT_FOUND");
    }
    expect(await QuizSession.countDocuments({})).toBe(0);
  });

  it.each([[{ topicId: "not-an-id" }], [{}], [undefined]])("rejects body %p with VALIDATION_ERROR", async (body) => {
    const res = await request(app).post("/api/quiz/start").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(typeof res.body.error.message).toBe("string");
  });

  it("never draws a question already retired on the topic", async () => {
    const questions = bank(4);
    const topic = await createTopic(questions, { retiredQuestions: [{ key: questions[1].key, text: questions[1].prompt, retiredAt: new Date() }] });

    const res = await start(topic._id);

    expect(res.status).toBe(201);
    expect(res.body.questions.map((q: QuizQuestionPayload) => q.id).sort()).toEqual([questions[0].id, questions[2].id, questions[3].id].sort());
  });
});

describe("POST /api/quiz/:sessionId/answer", () => {
  it("marks a correct option right and a wrong option wrong, showing the correct option both times", async () => {
    const questions = [mcq(1), mcq(2), mcq(3)];
    const topic = await createTopic(questions);
    const { body } = await start(topic._id);
    const [first, second] = body.questions as QuizQuestionPayload[];
    const answerOf = (id: string) => questions.find((q) => q.id === id)!.answer;

    const right = await answer(body.sessionId, first.id, answerOf(first.id));
    const wrongOption = second.options!.find((o) => o !== answerOf(second.id))!;
    const wrong = await answer(body.sessionId, second.id, wrongOption);

    expect(right.status).toBe(200);
    expect(right.body).toEqual({ questionId: first.id, correct: true, correctAnswer: answerOf(first.id) });
    expect(wrong.status).toBe(200);
    expect(wrong.body).toEqual({ questionId: second.id, correct: false, correctAnswer: answerOf(second.id) });
  });

  it("grades blanks ignoring case, extra spaces and trailing punctuation, accepts listed alternatives, and does no fuzzy matching", async () => {
    const co2: IBankQuestion = { id: "co2", key: "plants absorb ____ from the air", type: "fill_blank", prompt: "Plants absorb ____ from the air.", answer: "carbon dioxide", alternatives: ["CO2"] };
    const o2: IBankQuestion = { id: "o2", key: "plants release ____", type: "fill_blank", prompt: "Plants release ____.", answer: "oxygen", alternatives: ["O2"] };
    const site: IBankQuestion = { id: "site", key: "photosynthesis happens in the ____", type: "fill_blank", prompt: "Photosynthesis happens in the ____.", answer: "chloroplast" };
    const topic = await createTopic([co2, o2, site]);
    const { body } = await start(topic._id);

    const spaced = await answer(body.sessionId, "co2", "  Carbon   Dioxide. ");
    const alternative = await answer(body.sessionId, "o2", "o2!");
    const typo = await answer(body.sessionId, "site", "chloroplas");

    expect(spaced.body).toEqual({ questionId: "co2", correct: true, correctAnswer: "carbon dioxide" });
    expect(alternative.body).toEqual({ questionId: "o2", correct: true, correctAnswer: "oxygen" });
    expect(typo.body).toEqual({ questionId: "site", correct: false, correctAnswer: "chloroplast" });
  });

  it("returns the first result unchanged when a question is answered again", async () => {
    const questions = bank(3);
    const topic = await createTopic(questions);
    const { body } = await start(topic._id);
    const q = questions.find((x) => x.id === body.questions[0].id)!;

    const first = await answer(body.sessionId, q.id, responseFor(q, false));
    const again = await answer(body.sessionId, q.id, responseFor(q, true));

    expect(first.body).toEqual({ questionId: q.id, correct: false, correctAnswer: q.answer });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    const stored = (await QuizSession.findById(body.sessionId).lean())!.questions.find((x) => x.id === q.id)!;
    expect(stored).toMatchObject({ response: responseFor(q, false), correct: false });
  });

  it("grades a question once when two answers race", async () => {
    const questions = bank(3);
    const topic = await createTopic(questions);
    const { body } = await start(topic._id);
    const q = questions.find((x) => x.id === body.questions[0].id)!;

    const [a, b] = await Promise.all([answer(body.sessionId, q.id, responseFor(q, true)), answer(body.sessionId, q.id, responseFor(q, false))]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual(b.body);
    const stored = (await QuizSession.findById(body.sessionId).lean())!.questions.find((x) => x.id === q.id)!;
    expect(stored.correct).toBe(a.body.correct);
  });

  it("returns SESSION_NOT_FOUND for another user's session or an unknown one", async () => {
    const topic = await createTopic(bank(3));
    const { body } = await start(topic._id);

    const otherUsers = await answer(body.sessionId, body.questions[0].id, "x", OTHER_USER);
    const unknown = await answer("0123456789abcdef01234567", body.questions[0].id, "x");

    for (const res of [otherUsers, unknown]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("SESSION_NOT_FOUND");
    }
    const stored = (await QuizSession.findById(body.sessionId).lean())!;
    expect(stored.questions.every((q) => q.answeredAt === null)).toBe(true);
  });

  it("returns SESSION_NOT_FOUND for an expired session", async () => {
    const topic = await createTopic(bank(3));
    const { body } = await start(topic._id);
    await QuizSession.updateOne({ _id: body.sessionId }, { $set: { expiresAt: new Date(Date.now() - 1_000) } });

    const res = await answer(body.sessionId, body.questions[0].id, "x");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("SESSION_NOT_FOUND");
  });

  it("returns QUESTION_NOT_FOUND for a question that is not in the session", async () => {
    const topic = await createTopic(bank(3));
    const { body } = await start(topic._id);
    const res = await answer(body.sessionId, "not-in-this-quiz", "x");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("QUESTION_NOT_FOUND");
  });

  it.each([[{ questionId: "q" }], [{ response: "x" }], [{ questionId: "q", response: 7 }], [{ questionId: "", response: "x" }]])("rejects body %p with VALIDATION_ERROR", async (payload) => {
    const topic = await createTopic(bank(3));
    const { body } = await start(topic._id);
    const res = await request(app).post(`/api/quiz/${body.sessionId}/answer`).send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a malformed session id with VALIDATION_ERROR", async () => {
    const res = await answer("abc", "q", "x");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/quiz/:sessionId/flag", () => {
  it("refuses to flag a question before its answer is revealed and leaves the bank alone", async () => {
    const topic = await createTopic(bank(3));
    const { body } = await start(topic._id);

    const res = await flag(body.sessionId, body.questions[0].id);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("NOT_ANSWERED");
    const after = await storedTopic(topic._id);
    expect(after.retiredQuestions).toHaveLength(0);
    expect(after.questionBank.questions).toHaveLength(3);
    expect(after.questionBank.usableCount).toBe(3);
  });

  it("retires an answered question on the topic immediately, once, however often it is flagged", async () => {
    const questions = bank(15);
    const topic = await createTopic(questions);
    const { body } = await start(topic._id);
    const q = questions.find((x) => x.id === body.questions[0].id)!;
    await answer(body.sessionId, q.id, responseFor(q, true));

    const res = await flag(body.sessionId, q.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ questionId: q.id, flagged: true });
    let after = await storedTopic(topic._id);
    expect(after.retiredQuestions).toEqual([{ key: q.key, text: q.prompt, retiredAt: expect.any(Date) }]);
    expect(after.questionBank.questions.map((x) => x.key)).not.toContain(q.key);
    expect(after.questionBank.questions).toHaveLength(14);
    expect(after.questionBank.usableCount).toBe(14);

    const again = await flag(body.sessionId, q.id);

    expect(again.status).toBe(200);
    expect(again.body).toEqual({ questionId: q.id, flagged: true });
    after = await storedTopic(topic._id);
    expect(after.retiredQuestions).toHaveLength(1);
    expect(after.questionBank.usableCount).toBe(14);
    const stored = (await QuizSession.findById(body.sessionId).lean())!.questions.find((x) => x.id === q.id)!;
    expect(stored.flagged).toBe(true);
  });

  it("returns SESSION_NOT_FOUND for another user's session and QUESTION_NOT_FOUND for a stranger question", async () => {
    const questions = bank(3);
    const topic = await createTopic(questions);
    const { body } = await start(topic._id);
    const q = questions.find((x) => x.id === body.questions[0].id)!;
    await answer(body.sessionId, q.id, responseFor(q, true));

    const otherUsers = await flag(body.sessionId, q.id, OTHER_USER);
    const stranger = await flag(body.sessionId, "not-in-this-quiz");

    expect(otherUsers.status).toBe(404);
    expect(otherUsers.body.error.code).toBe("SESSION_NOT_FOUND");
    expect(stranger.status).toBe(404);
    expect(stranger.body.error.code).toBe("QUESTION_NOT_FOUND");
    expect((await storedTopic(topic._id)).retiredQuestions).toHaveLength(0);
  });

  it("still retires a question flagged after completion, leaving the stored result unchanged", async () => {
    const questions = bank(5);
    const topic = await createTopic(questions);
    const { sessionId, drawn } = await startAndAnswer(questions, [true, true, true, true, false], topic._id);
    const first = await complete(sessionId);
    expect(first.status).toBe(200);

    const res = await flag(sessionId, drawn[4].id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ questionId: drawn[4].id, flagged: true });
    const after = await storedTopic(topic._id);
    expect(after.retiredQuestions.map((r) => r.key)).toEqual([questions.find((q) => q.id === drawn[4].id)!.key]);
    expect(after.questionBank.usableCount).toBe(4);
    const repeat = await complete(sessionId);
    expect(repeat.body).toEqual(first.body);
    expect(await RevisionRecord.countDocuments({ topicId: topic._id })).toBe(1);
  });
});

describe("POST /api/quiz/:sessionId/complete", () => {
  it("covers AE1: three correct of four scored, with one miss flagged, records a 3", async () => {
    const questions = bank(5);
    const topic = await createTopic(questions);
    const { sessionId, drawn } = await startAndAnswer(questions, [true, true, true, false, false], topic._id);
    expect((await flag(sessionId, drawn[4].id)).status).toBe(200);

    const res = await complete(sessionId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rating: 3, scored: 4, correct: 3 });
    expect(typeof res.body.nextRevisionDate).toBe("string");
    const answerOf = (id: string) => questions.find((q) => q.id === id)!.answer;
    expect(res.body.results).toEqual(
      drawn.map((q, i) => ({ questionId: q.id, correct: i < 3, flagged: i === 4, correctAnswer: answerOf(q.id) })),
    );
    const record = await RevisionRecord.findOne({ topicId: topic._id }).lean();
    expect(record).toMatchObject({ method: "normal_quiz", userQuality: 3, finalQuality: 3, quizScored: 4, quizCorrect: 3 });
  });

  it("saves a rating of 0 like any other", async () => {
    const questions = bank(5);
    const topic = await createTopic(questions);
    const { sessionId } = await startAndAnswer(questions, [false, false, false, false, false], topic._id);

    const res = await complete(sessionId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rating: 0, scored: 5, correct: 0 });
    expect(typeof res.body.nextRevisionDate).toBe("string");
    const record = await RevisionRecord.findOne({ topicId: topic._id }).lean();
    expect(record).toMatchObject({ method: "normal_quiz", userQuality: 0, finalQuality: 0, quizScored: 5, quizCorrect: 0 });
    expect((await storedTopic(topic._id)).lastQuality).toBe(0);
  });

  it("covers AE4: flagging all five and completing records no rating, keeps the topic due and retires all five", async () => {
    const questions = bank(8);
    const topic = await createTopic(questions);
    const { sessionId, drawn } = await startAndAnswer(questions, [true, false, true, false, true], topic._id);
    for (const q of drawn) expect((await flag(sessionId, q.id)).status).toBe(200);

    const res = await complete(sessionId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rating: null, scored: 0, correct: 0, nextRevisionDate: null });
    expect(res.body.results.every((r: { flagged: boolean }) => r.flagged)).toBe(true);
    expect(await RevisionRecord.countDocuments({})).toBe(0);
    const after = await storedTopic(topic._id);
    expect(after.lastRevised).toBeNull();
    expect(after.revisionDate.toISOString()).toBe(topic.revisionDate.toISOString());
    const drawnKeys = drawn.map((q) => questions.find((x) => x.id === q.id)!.key).sort();
    expect(after.retiredQuestions.map((r) => r.key).sort()).toEqual(drawnKeys);
    expect(after.questionBank.usableCount).toBe(3);
    expect(after.questionBank.questions.map((q) => q.key)).toEqual(expect.not.arrayContaining(drawnKeys));
  });

  it("covers AE10: flagging three of five and completing records no rating and keeps the topic due", async () => {
    const questions = bank(5);
    const topic = await createTopic(questions);
    const { sessionId, drawn } = await startAndAnswer(questions, [true, true, true, true, true], topic._id);
    for (const q of drawn.slice(0, 3)) await flag(sessionId, q.id);

    const res = await complete(sessionId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rating: null, scored: 2, correct: 2, nextRevisionDate: null });
    expect(await RevisionRecord.countDocuments({})).toBe(0);
    const after = await storedTopic(topic._id);
    expect(after.lastRevised).toBeNull();
    expect(after.revisionDate.toISOString()).toBe(topic.revisionDate.toISOString());
    // Without a recorded review the topic is still due, so a new quiz can start (two questions remain: refused for size, not for being done).
    const again = await start(topic._id);
    expect(again.body.error.code).toBe("NOT_ENOUGH_QUESTIONS");
  });

  it("covers AE5: a session abandoned after flagging question 2 records nothing, and question 2 stays retired", async () => {
    const questions = bank(6);
    const topic = await createTopic(questions);
    const started = await start(topic._id);
    const [q1, q2] = (started.body.questions as QuizQuestionPayload[]).map((p) => questions.find((q) => q.id === p.id)!);
    await answer(started.body.sessionId, q1.id, responseFor(q1, true));
    await answer(started.body.sessionId, q2.id, responseFor(q2, false));
    expect((await flag(started.body.sessionId, q2.id)).status).toBe(200);

    // The learner leaves here.

    expect(await RevisionRecord.countDocuments({})).toBe(0);
    const after = await storedTopic(topic._id);
    expect(after.lastRevised).toBeNull();
    expect(after.retiredQuestions.map((r) => r.key)).toEqual([q2.key]);
    expect((await QuizSession.findById(started.body.sessionId).lean())!.status).toBe("active");
    const next = await start(topic._id);
    expect(next.status).toBe(201);
    expect(next.body.questions.map((q: QuizQuestionPayload) => q.id)).not.toContain(q2.id);
    expect(next.body.questions).toHaveLength(5);
  });

  it("returns the same result when completed twice, leaving one normal_quiz record with its counts", async () => {
    const questions = bank(5);
    const topic = await createTopic(questions);
    const { sessionId } = await startAndAnswer(questions, [true, true, true, true, false], topic._id);

    const first = await complete(sessionId);
    const second = await complete(sessionId);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ rating: 4, scored: 5, correct: 4 });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const records = await RevisionRecord.find({ topicId: topic._id }).lean();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ method: "normal_quiz", quizScored: 5, quizCorrect: 4, finalQuality: 4 });
    const session = (await QuizSession.findById(sessionId).lean())!;
    expect(session.status).toBe("completed");
    expect(session.expiresAt.getTime() - session.completedAt!.getTime()).toBe(QUIZ.COMPLETED_TTL_MS);
  });

  it("records once when the same session is completed concurrently", async () => {
    const questions = bank(5);
    const topic = await createTopic(questions);
    const { sessionId } = await startAndAnswer(questions, [true, true, true, false, false], topic._id);

    const responses = await Promise.all([complete(sessionId), complete(sessionId), complete(sessionId)]);

    const ok = responses.filter((r) => r.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of ok) expect(r.body).toEqual(ok[0].body);
    // A finish that loses the day claim before the winner's record lands is told the topic is done; it never records.
    for (const r of responses.filter((x) => x.status !== 200)) expect(r.body.error.code).toBe("ALREADY_REVIEWED_TODAY");
    expect(await RevisionRecord.countDocuments({ topicId: topic._id })).toBe(1);
    const repeat = await complete(sessionId);
    expect(repeat.body).toEqual(ok[0].body);
  });

  it("returns ALREADY_REVIEWED_TODAY when the topic was reviewed elsewhere today, recording nothing and keeping the session open", async () => {
    const questions = bank(5);
    const topic = await createTopic(questions);
    const { sessionId } = await startAndAnswer(questions, [true, true, true, true, true], topic._id);
    await recordRevision({ userId: USER, topicId: topic._id, userQuality: 2, method: "self", day: learnerDayFromHeader(undefined) });

    const res = await complete(sessionId);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_REVIEWED_TODAY");
    const records = await RevisionRecord.find({ topicId: topic._id }).lean();
    expect(records).toHaveLength(1);
    expect(records[0].method).toBe("self");
    expect((await storedTopic(topic._id)).lastQuality).toBe(2);
    expect((await QuizSession.findById(sessionId).lean())!).toMatchObject({ status: "active", result: null });
  });

  it("keeps grading an open session against its snapshot when the bank is regenerated mid-quiz", async () => {
    const questions = bank(5);
    const topic = await createTopic(questions);
    const started = await start(topic._id);
    const regenerated = questions.map((q) => ({ ...q, answer: `${q.answer} (rebuilt)`, options: q.options?.map((o) => `${o} (rebuilt)`), alternatives: undefined }));
    await Topic.updateOne({ _id: topic._id }, { $set: { "questionBank.questions": regenerated, "questionBank.builtAt": new Date() } });

    const byId = new Map(questions.map((q) => [q.id, q]));
    for (const q of started.body.questions as QuizQuestionPayload[]) {
      const original = byId.get(q.id)!;
      const res = await answer(started.body.sessionId, q.id, original.answer);
      expect(res.body).toEqual({ questionId: q.id, correct: true, correctAnswer: original.answer });
    }
    const res = await complete(started.body.sessionId);
    expect(res.body).toMatchObject({ rating: 5, scored: 5, correct: 5 });
  });

  it("returns INCOMPLETE while a question is unanswered, recording nothing", async () => {
    const questions = bank(5);
    const topic = await createTopic(questions);
    const started = await start(topic._id);
    for (const p of (started.body.questions as QuizQuestionPayload[]).slice(0, 4)) {
      await answer(started.body.sessionId, p.id, responseFor(questions.find((q) => q.id === p.id)!, true));
    }

    const res = await complete(started.body.sessionId);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INCOMPLETE");
    expect(await RevisionRecord.countDocuments({})).toBe(0);
    expect((await QuizSession.findById(started.body.sessionId).lean())!.status).toBe("active");
  });

  it("returns SESSION_NOT_FOUND for another user's session", async () => {
    const questions = bank(3);
    const topic = await createTopic(questions);
    const { sessionId } = await startAndAnswer(questions, [true, true, true], topic._id);

    const res = await complete(sessionId, OTHER_USER);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("SESSION_NOT_FOUND");
    expect(await RevisionRecord.countDocuments({})).toBe(0);
  });

  it("returns TOPIC_NOT_FOUND when the topic was deleted mid-quiz", async () => {
    const questions = bank(3);
    const topic = await createTopic(questions);
    const { sessionId } = await startAndAnswer(questions, [true, true, true], topic._id);
    await Topic.deleteOne({ _id: topic._id });

    const res = await complete(sessionId);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("TOPIC_NOT_FOUND");
    expect(await RevisionRecord.countDocuments({})).toBe(0);
  });
});
