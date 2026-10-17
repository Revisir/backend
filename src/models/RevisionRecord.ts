import { Schema, model, Document, Types } from 'mongoose';

export const REVISION_METHODS = ["self", "ai_quiz", "normal_quiz"] as const;
export type RevisionMethod = (typeof REVISION_METHODS)[number];

/**
 * Interface for RevisionRecord document
 */
export interface IRevisionRecord extends Document {
  _id: Types.ObjectId;
  userId: string; // Cognito user ID
  topicId: Types.ObjectId;
  revisionDate: Date;
  userQuality: number;
  llmQuality: number;
  finalQuality: number;
  newEFactor: number;
  newInterval: number;
  nextRevisionDate: Date;
  /** How the review was taken. Records written before this field existed read as `self`. */
  method: RevisionMethod;
  /** Normal quiz only: questions that counted toward the score, and how many were right. */
  quizScored?: number | null;
  quizCorrect?: number | null;
  /** The chat or quiz session that produced this review, for idempotent completion. */
  sessionId?: Types.ObjectId | null;
  createdAt: Date;
}

/**
 * Mongoose schema for RevisionRecord document
 */
const RevisionRecordSchema = new Schema<IRevisionRecord>({
  userId: {
    type: String,
    required: true,
    index: true
  },
  topicId: { 
    type: Schema.Types.ObjectId, 
    ref: 'Topic', 
    required: true 
  },
  revisionDate: { 
    type: Date, 
    required: true 
  },
  userQuality: {
    type: Number,
    required: true,
    min: 0,
    max: 5
  },
  llmQuality: {
    type: Number,
    required: true,
    min: 0,
    max: 5
  },
  finalQuality: {
    type: Number,
    required: true,
    min: 0,
    max: 5
  },
  newEFactor: { 
    type: Number, 
    required: true 
  },
  newInterval: { 
    type: Number, 
    required: true 
  },
  nextRevisionDate: { 
    type: Date, 
    required: true 
  },
  method: {
    type: String,
    enum: REVISION_METHODS,
    default: "self"
  },
  quizScored: {
    type: Number,
    min: 0,
    default: null
  },
  quizCorrect: {
    type: Number,
    min: 0,
    default: null
  },
  sessionId: {
    type: Schema.Types.ObjectId,
    default: null
  }
}, {
  timestamps: { createdAt: true, updatedAt: false }
});

/**
 * Compound index for efficient queries
 * Optimizes queries for revision history by user, topic and date
 */
RevisionRecordSchema.index({ userId: 1, topicId: 1, revisionDate: -1 });
RevisionRecordSchema.index({ userId: 1, sessionId: 1 }, { partialFilterExpression: { sessionId: { $type: "objectId" } } });

/**
 * RevisionRecord model
 */
export const RevisionRecord = model<IRevisionRecord>('RevisionRecord', RevisionRecordSchema);
