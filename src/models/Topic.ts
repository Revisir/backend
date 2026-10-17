import { Schema, model, Document, Types } from "mongoose";

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
  extractedContentUrl?: string;
  processedAt: Date;
  processingStatus: "pending" | "processing" | "completed" | "failed";
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
  processingStatus: "pending" | "processing" | "completed" | "failed";
  errorReason?: string;
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
  urls: Types.DocumentArray<IAttachedUrl>;
  files: Types.DocumentArray<IAttachedFile>;
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
    enum: ["pending", "processing", "completed", "failed"],
    default: "pending",
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
    enum: ["pending", "processing", "completed", "failed"],
    default: "pending",
  },
  errorReason: {
    type: String,
    maxlength: 500,
    default: null,
  },
});

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
    urls: {
      type: [AttachedUrlSchema],
      default: [],
    },
    files: [AttachedFileSchema],
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
