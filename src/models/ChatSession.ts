import { Schema, model, Document, Types } from 'mongoose';

/**
 * Interface for a pre-generated question
 */
export interface IQuestion {
  question: string;
  answer: string;
}

/**
 * Interface for Message subdocument
 */
export interface IMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

/**
 * Interface for ChatSession document
 */
export interface IChatSession extends Document {
  _id: Types.ObjectId;
  userId: string; // Cognito user ID
  topicId: Types.ObjectId;
  startedAt: Date;
  completedAt: Date | null;
  messages: IMessage[];
  questions: IQuestion[];
  currentQuestionIndex: number;
  active: boolean;
}

/**
 * Mongoose schema for Message subdocument
 */
const MessageSchema = new Schema<IMessage>({
  role: { 
    type: String, 
    enum: ['user', 'assistant'], 
    required: true 
  },
  content: { 
    type: String, 
    required: true 
  },
  timestamp: { 
    type: Date, 
    default: Date.now 
  }
}, { _id: false });

const QuestionSchema = new Schema<IQuestion>({
  question: { type: String, required: true },
  answer: { type: String, required: true }
}, { _id: false });

/**
 * Mongoose schema for ChatSession document
 */
const ChatSessionSchema = new Schema<IChatSession>({
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
  startedAt: { 
    type: Date, 
    default: Date.now 
  },
  completedAt: { 
    type: Date, 
    default: null 
  },
  messages: [MessageSchema],
  questions: [QuestionSchema],
  currentQuestionIndex: {
    type: Number,
    default: 0
  },
  active: { 
    type: Boolean, 
    default: true 
  }
});

/**
 * Compound index for efficient queries
 * Optimizes queries for active chat sessions by user and topic
 */
ChatSessionSchema.index({ userId: 1, topicId: 1, active: 1 });

/**
 * ChatSession model
 */
export const ChatSession = model<IChatSession>('ChatSession', ChatSessionSchema);
