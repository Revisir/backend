import { RevisionRecord } from './RevisionRecord';
import mongoose from 'mongoose';

/**
 * Basic unit tests for RevisionRecord schema
 * These tests verify the schema structure and validation without requiring a database connection
 */

describe('RevisionRecord Schema', () => {
  describe('Schema Structure', () => {
    it('should have all required fields defined', () => {
      const schema = RevisionRecord.schema;
      
      // Check required fields exist
      expect(schema.path('topicId')).toBeDefined();
      expect(schema.path('revisionDate')).toBeDefined();
      expect(schema.path('userQuality')).toBeDefined();
      expect(schema.path('llmQuality')).toBeDefined();
      expect(schema.path('finalQuality')).toBeDefined();
      expect(schema.path('previousEFactor')).toBeDefined();
      expect(schema.path('newEFactor')).toBeDefined();
      expect(schema.path('previousInterval')).toBeDefined();
      expect(schema.path('newInterval')).toBeDefined();
      expect(schema.path('nextRevisionDate')).toBeDefined();
    });

    it('should have correct field types', () => {
      const schema = RevisionRecord.schema;
      
      expect(schema.path('topicId').instance).toBe('ObjectId');
      expect(schema.path('revisionDate').instance).toBe('Date');
      expect(schema.path('userQuality').instance).toBe('Number');
      expect(schema.path('llmQuality').instance).toBe('Number');
      expect(schema.path('finalQuality').instance).toBe('Number');
      expect(schema.path('previousEFactor').instance).toBe('Number');
      expect(schema.path('newEFactor').instance).toBe('Number');
      expect(schema.path('previousInterval').instance).toBe('Number');
      expect(schema.path('newInterval').instance).toBe('Number');
      expect(schema.path('nextRevisionDate').instance).toBe('Date');
    });

    it('should have correct validation constraints for quality scores', () => {
      const schema = RevisionRecord.schema;
      
      // Check min/max for quality scores (0-5)
      expect(schema.path('userQuality').options.min).toBe(0);
      expect(schema.path('userQuality').options.max).toBe(5);
      expect(schema.path('llmQuality').options.min).toBe(0);
      expect(schema.path('llmQuality').options.max).toBe(5);
      expect(schema.path('finalQuality').options.min).toBe(0);
      expect(schema.path('finalQuality').options.max).toBe(5);
    });

    it('should have all fields marked as required', () => {
      const schema = RevisionRecord.schema;
      
      expect(schema.path('topicId').isRequired).toBe(true);
      expect(schema.path('revisionDate').isRequired).toBe(true);
      expect(schema.path('userQuality').isRequired).toBe(true);
      expect(schema.path('llmQuality').isRequired).toBe(true);
      expect(schema.path('finalQuality').isRequired).toBe(true);
      expect(schema.path('previousEFactor').isRequired).toBe(true);
      expect(schema.path('newEFactor').isRequired).toBe(true);
      expect(schema.path('previousInterval').isRequired).toBe(true);
      expect(schema.path('newInterval').isRequired).toBe(true);
      expect(schema.path('nextRevisionDate').isRequired).toBe(true);
    });

    it('should have timestamps enabled with createdAt only', () => {
      const schema = RevisionRecord.schema;
      expect(schema.options.timestamps).toEqual({ createdAt: true, updatedAt: false });
    });

    it('should have compound index on topicId and revisionDate', () => {
      const indexes = RevisionRecord.schema.indexes();
      
      // Check that compound index exists
      const compoundIndex = indexes.find((idx: any) => {
        const keys = Object.keys(idx[0]);
        return keys.includes('topicId') && keys.includes('revisionDate');
      });
      
      expect(compoundIndex).toBeDefined();
      expect(compoundIndex![0]).toEqual({ topicId: 1, revisionDate: -1 });
    });

    it('should reference Topic collection', () => {
      const schema = RevisionRecord.schema;
      const topicIdPath = schema.path('topicId') as any;
      
      expect(topicIdPath.options.ref).toBe('Topic');
    });
  });

  describe('Document Creation', () => {
    it('should create a revision record with all required fields', () => {
      const topicId = new mongoose.Types.ObjectId();
      const recordData = {
        topicId: topicId,
        revisionDate: new Date('2024-01-15'),
        userQuality: 4,
        llmQuality: 5,
        finalQuality: 4.5,
        previousEFactor: 2.5,
        newEFactor: 2.6,
        previousInterval: 1,
        newInterval: 6,
        nextRevisionDate: new Date('2024-01-21')
      };
      
      const record = new RevisionRecord(recordData);
      
      expect(record.topicId.toString()).toBe(topicId.toString());
      expect(record.revisionDate).toEqual(recordData.revisionDate);
      expect(record.userQuality).toBe(recordData.userQuality);
      expect(record.llmQuality).toBe(recordData.llmQuality);
      expect(record.finalQuality).toBe(recordData.finalQuality);
      expect(record.previousEFactor).toBe(recordData.previousEFactor);
      expect(record.newEFactor).toBe(recordData.newEFactor);
      expect(record.previousInterval).toBe(recordData.previousInterval);
      expect(record.newInterval).toBe(recordData.newInterval);
      expect(record.nextRevisionDate).toEqual(recordData.nextRevisionDate);
    });

    it('should create a record with quality scores at boundaries', () => {
      const topicId = new mongoose.Types.ObjectId();
      
      // Test minimum quality (0)
      const recordMin = new RevisionRecord({
        topicId: topicId,
        revisionDate: new Date(),
        userQuality: 0,
        llmQuality: 0,
        finalQuality: 0,
        previousEFactor: 2.5,
        newEFactor: 1.3,
        previousInterval: 6,
        newInterval: 1,
        nextRevisionDate: new Date()
      });
      
      expect(recordMin.userQuality).toBe(0);
      expect(recordMin.llmQuality).toBe(0);
      expect(recordMin.finalQuality).toBe(0);
      
      // Test maximum quality (5)
      const recordMax = new RevisionRecord({
        topicId: topicId,
        revisionDate: new Date(),
        userQuality: 5,
        llmQuality: 5,
        finalQuality: 5,
        previousEFactor: 2.5,
        newEFactor: 2.5,
        previousInterval: 1,
        newInterval: 6,
        nextRevisionDate: new Date()
      });
      
      expect(recordMax.userQuality).toBe(5);
      expect(recordMax.llmQuality).toBe(5);
      expect(recordMax.finalQuality).toBe(5);
    });

    it('should create a record tracking E-Factor changes', () => {
      const topicId = new mongoose.Types.ObjectId();
      const record = new RevisionRecord({
        topicId: topicId,
        revisionDate: new Date(),
        userQuality: 3,
        llmQuality: 3,
        finalQuality: 3,
        previousEFactor: 2.5,
        newEFactor: 2.36, // Calculated by SM-2 algorithm
        previousInterval: 6,
        newInterval: 14,
        nextRevisionDate: new Date()
      });
      
      expect(record.previousEFactor).toBe(2.5);
      expect(record.newEFactor).toBe(2.36);
    });

    it('should create a record tracking interval changes', () => {
      const topicId = new mongoose.Types.ObjectId();
      const record = new RevisionRecord({
        topicId: topicId,
        revisionDate: new Date(),
        userQuality: 4,
        llmQuality: 4,
        finalQuality: 4,
        previousEFactor: 2.5,
        newEFactor: 2.5,
        previousInterval: 1,
        newInterval: 6,
        nextRevisionDate: new Date()
      });
      
      expect(record.previousInterval).toBe(1);
      expect(record.newInterval).toBe(6);
    });

    it('should create a record for a failed revision (quality < 3)', () => {
      const topicId = new mongoose.Types.ObjectId();
      const record = new RevisionRecord({
        topicId: topicId,
        revisionDate: new Date(),
        userQuality: 2,
        llmQuality: 1,
        finalQuality: 1.5,
        previousEFactor: 2.3,
        newEFactor: 2.3, // E-Factor unchanged on failure
        previousInterval: 14,
        newInterval: 1, // Reset to 1 day
        nextRevisionDate: new Date()
      });
      
      expect(record.finalQuality).toBe(1.5);
      expect(record.newInterval).toBe(1);
    });
  });

  describe('Validation', () => {
    it('should validate that topicId is required', () => {
      const record = new RevisionRecord({
        revisionDate: new Date(),
        userQuality: 4,
        llmQuality: 5,
        finalQuality: 4.5,
        previousEFactor: 2.5,
        newEFactor: 2.6,
        previousInterval: 1,
        newInterval: 6,
        nextRevisionDate: new Date()
      });
      
      const error = record.validateSync();
      expect(error).toBeDefined();
      expect(error?.errors.topicId).toBeDefined();
    });

    it('should validate that all quality fields are required', () => {
      const topicId = new mongoose.Types.ObjectId();
      const record = new RevisionRecord({
        topicId: topicId,
        revisionDate: new Date(),
        // Missing quality fields
        previousEFactor: 2.5,
        newEFactor: 2.6,
        previousInterval: 1,
        newInterval: 6,
        nextRevisionDate: new Date()
      });
      
      const error = record.validateSync();
      expect(error).toBeDefined();
      expect(error?.errors.userQuality).toBeDefined();
      expect(error?.errors.llmQuality).toBeDefined();
      expect(error?.errors.finalQuality).toBeDefined();
    });

    it('should validate that all E-Factor and interval fields are required', () => {
      const topicId = new mongoose.Types.ObjectId();
      const record = new RevisionRecord({
        topicId: topicId,
        revisionDate: new Date(),
        userQuality: 4,
        llmQuality: 5,
        finalQuality: 4.5,
        // Missing E-Factor and interval fields
        nextRevisionDate: new Date()
      });
      
      const error = record.validateSync();
      expect(error).toBeDefined();
      expect(error?.errors.previousEFactor).toBeDefined();
      expect(error?.errors.newEFactor).toBeDefined();
      expect(error?.errors.previousInterval).toBeDefined();
      expect(error?.errors.newInterval).toBeDefined();
    });
  });
});
