import mongoose from 'mongoose';
import { logger } from "@config/logger.js";

const log = logger.child({ module: "database" });

export const connectDatabase = async (): Promise<void> => {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/revision-study-reminder';
    
    await mongoose.connect(mongoUri);
    
    log.info('MongoDB connected successfully');
    
    mongoose.connection.on('error', (error) => {
      log.error({ err: error }, 'MongoDB connection error');
    });
    
    mongoose.connection.on('disconnected', () => {
      log.warn('MongoDB disconnected');
    });
    
  } catch (error) {
    log.fatal({ err: error }, 'Failed to connect to MongoDB');
    throw error;
  }
};
