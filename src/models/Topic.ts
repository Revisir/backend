import { Schema, model, Document, Types } from "mongoose";

/**
 * Interface for AttachedFile subdocument
 */
export interface IAttachedFile {
  _id?: Types.ObjectId;
  fileName: string;
  fileType: "image" | "pdf" | "url" | "text";
  // fileUrl: string;
  s3Path: string;
  s3Bucket: string;
  extractedContentUrl: string;
  processedAt: Date;
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
  files: IAttachedFile[];
  mindMap: string | null;
  mindMapGeneratedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  isDue: boolean; // virtual field
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
    enum: ["image", "pdf", "url", "text"],
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
    required: true,
  },
  processedAt: {
    type: Date,
    default: Date.now,
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
 * Topic model
 */
export const Topic = model<ITopic>("Topic", TopicSchema);
