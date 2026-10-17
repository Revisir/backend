import { Schema, model, Document, Types } from "mongoose";

/**
 * One drawn question, snapshotted from the topic's bank when the quiz starts
 * (KTD7), so a rebuild of the bank cannot change an open quiz. The answer
 * fields never leave the server before the learner answers.
 */
export interface IQuizQuestion {
  /** The bank question's id; the client addresses the question by it. */
  id: string;
  /** The bank question's retirement key (`normalizeText(prompt)`). */
  key: string;
  type: "mcq" | "fill_blank";
  prompt: string;
  /** Multiple choice: the options in the order this quiz shows them (shuffled at start). */
  options?: string[];
  answer: string;
  /** Fill in the blank: other answers that also count as correct. */
  alternatives?: string[];
  /** The learner's response as submitted; null until answered. */
  response: string | null;
  correct: boolean | null;
  /** Set once, by the first answer; later answers return the stored result. */
  answeredAt: Date | null;
  /** Flagged as a bad question: left out of the score and retired on the topic. */
  flagged: boolean;
}

/** One question's line in a completed quiz's result. */
export interface IQuizResultItem {
  questionId: string;
  correct: boolean;
  flagged: boolean;
  correctAnswer: string;
}

/** The recorded outcome of a completed quiz, returned again on a repeat completion. */
export interface IQuizResult {
  /** 0–5, or null when fewer than three questions were scored and nothing was recorded. */
  rating: number | null;
  scored: number;
  correct: number;
  nextRevisionDate: Date | null;
  results: IQuizResultItem[];
}

export type QuizSessionStatus = "active" | "completed";

/**
 * A normal quiz in progress or completed. Graded per answer on the server;
 * completion records the review once and stores its result.
 */
export interface IQuizSession extends Document {
  _id: Types.ObjectId;
  userId: string; // Cognito user ID
  topicId: Types.ObjectId;
  topicName: string;
  questions: IQuizQuestion[];
  status: QuizSessionStatus;
  result: IQuizResult | null;
  startedAt: Date;
  completedAt: Date | null;
  /** TTL: `startedAt + QUIZ.SESSION_TTL_MS`, moved to `completedAt + QUIZ.COMPLETED_TTL_MS` on completion. */
  expiresAt: Date;
}

const QuizQuestionSchema = new Schema<IQuizQuestion>(
  {
    id: { type: String, required: true },
    key: { type: String, required: true },
    type: { type: String, enum: ["mcq", "fill_blank"], required: true },
    prompt: { type: String, required: true },
    options: { type: [String], default: undefined },
    answer: { type: String, required: true },
    alternatives: { type: [String], default: undefined },
    response: { type: String, default: null },
    correct: { type: Boolean, default: null },
    answeredAt: { type: Date, default: null },
    flagged: { type: Boolean, default: false },
  },
  { _id: false },
);

const QuizResultItemSchema = new Schema<IQuizResultItem>(
  {
    questionId: { type: String, required: true },
    correct: { type: Boolean, required: true },
    flagged: { type: Boolean, required: true },
    correctAnswer: { type: String, required: true },
  },
  { _id: false },
);

const QuizResultSchema = new Schema<IQuizResult>(
  {
    rating: { type: Number, default: null, min: 0, max: 5 },
    scored: { type: Number, required: true, min: 0 },
    correct: { type: Number, required: true, min: 0 },
    nextRevisionDate: { type: Date, default: null },
    results: { type: [QuizResultItemSchema], default: [] },
  },
  { _id: false },
);

const QuizSessionSchema = new Schema<IQuizSession>({
  userId: { type: String, required: true },
  topicId: { type: Schema.Types.ObjectId, ref: "Topic", required: true },
  topicName: { type: String, required: true },
  questions: { type: [QuizQuestionSchema], default: [] },
  status: { type: String, enum: ["active", "completed"], default: "active" },
  result: { type: QuizResultSchema, default: null },
  startedAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
});

/** Every lookup is scoped by user. */
QuizSessionSchema.index({ userId: 1, _id: 1 });
/** Abandoned sessions expire; completed ones are kept a while for repeat completions. */
QuizSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const QuizSession = model<IQuizSession>("QuizSession", QuizSessionSchema);
