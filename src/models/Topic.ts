import { Schema, model, Document, Types } from "mongoose";

export const PROCESSING_STATUSES = ["pending", "processing", "completed", "failed"] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

/**
 * Interface for AttachedFile subdocument
 */
export interface IAttachedFile {
  _id?: Types.ObjectId;
  fileName: string;
  fileType: "image" | "pdf" | "text";
  // fileUrl: string;
  s3Path: string;
  s3Bucket: string;
  /** Declared size at upload, or the stored object's size when the worker created the entry. */
  size?: number | null;
  extractedContentUrl?: string;
  processedAt: Date;
  processingStatus: ProcessingStatus;
  /** When `processingStatus` last changed; drives the staleness window. Missing on legacy entries. */
  statusUpdatedAt?: Date | null;
  errorReason?: string;
}

/**
 * Interface for AttachedUrl subdocument
 */
export interface IAttachedUrl {
  _id?: Types.ObjectId;
  url: string;
  extractedContentPath?: string;
  processedAt?: Date;
  processingStatus: ProcessingStatus;
  /** When `processingStatus` last changed; drives the staleness window. Missing on legacy entries. */
  statusUpdatedAt?: Date | null;
  errorReason?: string;
}

export const BANK_STATES = ["none", "queued", "building", "ready", "empty", "failed"] as const;
export type BankState = (typeof BANK_STATES)[number];

export const QUESTION_TYPES = ["mcq", "fill_blank"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/**
 * One checked question in a topic's bank. Answers never leave the server
 * except one at a time, after the learner has answered that question.
 */
export interface IBankQuestion {
  /** Random id, stable for the life of one build. */
  id: string;
  /** `normalizeText(prompt)`: the retirement and de-duplication key. */
  key: string;
  type: QuestionType;
  /** A fill-in-the-blank prompt contains exactly one `____`. */
  prompt: string;
  /** Multiple choice: four unique options, one of which equals `answer`. */
  options?: string[];
  answer: string;
  /** Fill in the blank: other answers that also count as correct. */
  alternatives?: string[];
}

/**
 * A topic's question bank and the state of its builds.
 *
 * `questions` is replaced on every successful build and stays usable while a
 * rebuild is queued or building, and after an empty or failed one (R38).
 */
export interface IQuestionBank {
  state: BankState;
  questions: IBankQuestion[];
  /** Denormalized `questions.length`, so availability never has to load the questions. */
  usableCount: number;
  /** When the latest build was requested. */
  requestedAt: Date | null;
  /** Claim time of the running build. */
  claimedAt: Date | null;
  /** `requestedAt` of the queue message holding the claim; a redelivery of it may take the claim over. */
  claimRequestedAt: Date | null;
  /** Claim time of the last build that finished as ready or empty. Requests older than this are already covered. */
  sourcedAt: Date | null;
  builtAt: Date | null;
  /** Sweep republishes of a stalled build. */
  attempts: number;
  errorCode: string | null;
  errorReason: string | null;
}

/** A flagged question. The list is append-only and survives every build. */
export interface IRetiredQuestion {
  key: string;
  text: string;
  retiredAt: Date;
}

/**
 * Interface for Topic document
 */
export interface ITopic extends Document {
  _id: Types.ObjectId;
  userId: string; // Cognito user ID
  topicName: string;
  subjectName: string;
  description: string;
  dateStudied: Date;
  revisionDate: Date;
  lastRevised: Date | null;
  eFactor: number;
  repetitionNumber: number;
  interval: number;
  /** Final rating (0–5) of the latest review; null before the first. Older AI reviews may hold halves. */
  lastQuality: number | null;
  /** The chat or quiz session whose completion recorded the latest review, if any. */
  lastReviewSessionId: Types.ObjectId | null;
  urls: Types.DocumentArray<IAttachedUrl>;
  files: Types.DocumentArray<IAttachedFile>;
  questionBank: IQuestionBank;
  retiredQuestions: IRetiredQuestion[];
  mindMap: string | null;
  mindMapGeneratedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  isDue: boolean; // virtual field
  isProcessingComplete: boolean; // virtual field
}

/**
 * Mongoose schema for AttachedFile subdocument
 */
const AttachedFileSchema = new Schema<IAttachedFile>({
  fileName: {
    type: String,
    required: true,
  },
  fileType: {
    type: String,
    enum: ["image", "pdf", "text"],
    required: true,
  },
  // fileUrl: {
  //   type: String,
  //   required: true,
  // },
  s3Path: {
    type: String,
    required: true,
  },
  s3Bucket: {
    type: String,
    required: true,
  },
  size: {
    type: Number,
    default: null,
  },
  extractedContentUrl: {
    type: String,
    default: null,
  },
  processedAt: {
    type: Date,
    default: Date.now,
  },
  processingStatus: {
    type: String,
    enum: PROCESSING_STATUSES,
    default: "pending",
  },
  // No default: a hydrated legacy entry must not look freshly updated.
  // Readers fall back to the subdocument _id's creation time.
  statusUpdatedAt: {
    type: Date,
    default: null,
  },
  errorReason: {
    type: String,
    maxlength: 500,
    default: null,
  },
});

/**
 * Mongoose schema for AttachedUrl subdocument
 */
const AttachedUrlSchema = new Schema<IAttachedUrl>({
  url: {
    type: String,
    required: true,
  },
  extractedContentPath: {
    type: String,
    default: null,
  },
  processedAt: {
    type: Date,
    default: null,
  },
  processingStatus: {
    type: String,
    enum: PROCESSING_STATUSES,
    default: "pending",
  },
  // No default: a hydrated legacy entry must not look freshly updated.
  // Readers fall back to the subdocument _id's creation time.
  statusUpdatedAt: {
    type: Date,
    default: null,
  },
  errorReason: {
    type: String,
    maxlength: 500,
    default: null,
  },
});

const BankQuestionSchema = new Schema<IBankQuestion>(
  {
    id: { type: String, required: true },
    key: { type: String, required: true },
    type: { type: String, enum: QUESTION_TYPES, required: true },
    prompt: { type: String, required: true },
    options: { type: [String], default: undefined },
    answer: { type: String, required: true },
    alternatives: { type: [String], default: undefined },
  },
  { _id: false },
);

const RetiredQuestionSchema = new Schema<IRetiredQuestion>(
  {
    key: { type: String, required: true },
    text: { type: String, required: true },
    retiredAt: { type: Date, required: true },
  },
  { _id: false },
);

/**
 * Mongoose schema for Topic document
 */
const TopicSchema = new Schema<ITopic>(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    topicName: {
      type: String,
      required: true,
      maxlength: 200,
    },
    subjectName: {
      type: String,
      required: true,
      maxlength: 100,
    },
    description: {
      type: String,
      default: "",
    },
    dateStudied: {
      type: Date,
      required: true,
    },
    revisionDate: {
      type: Date,
      required: true,
    },
    lastRevised: {
      type: Date,
      default: null,
    },
    eFactor: {
      type: Number,
      default: 2.5,
      min: 1.3,
      max: 2.5,
    },
    repetitionNumber: {
      type: Number,
      default: 0,
      min: 0,
    },
    interval: {
      type: Number,
      default: 1,
      min: 1,
    },
    lastQuality: {
      type: Number,
      default: null,
      min: 0,
      max: 5,
    },
    lastReviewSessionId: {
      type: Schema.Types.ObjectId,
      default: null,
    },
    urls: {
      type: [AttachedUrlSchema],
      default: [],
    },
    files: [AttachedFileSchema],
    // No defaults on state, usableCount or attempts: Mongoose saves a non-null
    // default applied at hydration, so a topic loaded before a bank write and
    // saved after it would overwrite that write. A missing value reads as
    // none/0 (`toQuestionBankView`). Null defaults are never written.
    questionBank: {
      state: { type: String, enum: BANK_STATES },
      // Answer keys: excluded from every topic query unless explicitly selected.
      questions: { type: [BankQuestionSchema], default: [], select: false },
      usableCount: { type: Number, min: 0 },
      requestedAt: { type: Date, default: null },
      claimedAt: { type: Date, default: null },
      claimRequestedAt: { type: Date, default: null },
      sourcedAt: { type: Date, default: null },
      builtAt: { type: Date, default: null },
      attempts: { type: Number },
      errorCode: { type: String, default: null },
      errorReason: { type: String, maxlength: 500, default: null },
    },
    retiredQuestions: {
      type: [RetiredQuestionSchema],
      default: [],
      select: false,
    },
    mindMap: {
      type: String,
      default: null,
    },
    mindMapGeneratedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true, // auto-creates createdAt and updatedAt
  },
);

/**
 * Virtual field for isDue calculation
 * Returns true if the revision date is less than or equal to the current date
 */
TopicSchema.virtual("isDue").get(function (this: ITopic) {
  return this.revisionDate <= new Date();
});

/**
 * Virtual field for isProcessingComplete calculation
 * Returns true when all URLs and files have status "completed" or "failed"
 * Also returns true when both arrays are empty
 */
TopicSchema.virtual("isProcessingComplete").get(function (this: ITopic) {
  const allUrls = this.urls.every(
    (u) => u.processingStatus === "completed" || u.processingStatus === "failed"
  );
  const allFiles = this.files.every(
    (f) => f.processingStatus === "completed" || f.processingStatus === "failed"
  );
  return allUrls && allFiles;
});

/**
 * Ensure virtuals are included when converting to JSON
 */
TopicSchema.set("toJSON", { virtuals: true });
TopicSchema.set("toObject", { virtuals: true });

/**
 * Indexes for performance optimization
 */
TopicSchema.index({ userId: 1, revisionDate: 1 }); // for user-specific due topics queries
TopicSchema.index({ userId: 1, subjectName: 1 }); // for user-specific subject filtering
TopicSchema.index({ userId: 1, createdAt: -1 }); // for user-specific recent topics
TopicSchema.index({ "questionBank.state": 1 }); // for the stalled-bank sweep
TopicSchema.index({ "files.processingStatus": 1 }); // for the stale-attachment sweep
TopicSchema.index({ "urls.processingStatus": 1 });

/**
 * Truncates an error reason string to at most 500 characters.
 * Application-level truncation ensures errorReason fits the maxlength constraint
 * before storing in a URL or file subdocument.
 */
export function truncateErrorReason(reason: string): string {
  return reason.length > 500 ? reason.substring(0, 500) : reason;
}

/**
 * Valid processing status transitions.
 * Only these from → to transitions are allowed:
 * - pending → processing
 * - processing → completed
 * - processing → failed
 */
const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ["processing"],
  processing: ["completed", "failed"],
  completed: [],
  failed: [],
};

/**
 * Validates whether a processing status transition is allowed.
 * Returns true only for: pending→processing, processing→completed, processing→failed.
 */
export function isValidStatusTransition(
  from: "pending" | "processing" | "completed" | "failed",
  to: "pending" | "processing" | "completed" | "failed"
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Topic model
 */
export const Topic = model<ITopic>("Topic", TopicSchema);
