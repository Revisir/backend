import { Schema, model, Document, Types } from 'mongoose';

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
    min: 1, 
    max: 5 
  },
  llmQuality: { 
    type: Number, 
    required: true, 
    min: 1, 
    max: 5 
  },
  finalQuality: { 
    type: Number, 
    required: true, 
    min: 1, 
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
  }
}, {
  timestamps: { createdAt: true, updatedAt: false }
});

/**
 * Compound index for efficient queries
 * Optimizes queries for revision history by user, topic and date
 */
RevisionRecordSchema.index({ userId: 1, topicId: 1, revisionDate: -1 });

/**
 * RevisionRecord model
 */
export const RevisionRecord = model<IRevisionRecord>('RevisionRecord', RevisionRecordSchema);
