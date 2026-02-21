import request from 'supertest';
import express from 'express';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import statisticsRoutes from '../routes/statisticsRoutes';
import { Topic } from '../models/Topic';
import { RevisionRecord } from '../models/RevisionRecord';

const app = express();
app.use(express.json());
app.use('/api/statistics', statisticsRoutes);

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Topic.deleteMany({});
  await RevisionRecord.deleteMany({});
});

describe('GET /api/statistics', () => {
  it('should return statistics with all fields', async () => {
    const response = await request(app).get('/api/statistics');

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('totalTopics');
    expect(response.body).toHaveProperty('dueToday');
    expect(response.body).toHaveProperty('revisedThisWeek');
    expect(response.body).toHaveProperty('revisedThisMonth');
    expect(response.body).toHaveProperty('upcomingRevisions');
    expect(Array.isArray(response.body.upcomingRevisions)).toBe(true);
  });

  it('should return zero counts for empty database', async () => {
    const response = await request(app).get('/api/statistics');

    expect(response.status).toBe(200);
    expect(response.body.totalTopics).toBe(0);
    expect(response.body.dueToday).toBe(0);
    expect(response.body.revisedThisWeek).toBe(0);
    expect(response.body.revisedThisMonth).toBe(0);
    expect(response.body.upcomingRevisions).toEqual([]);
  });

  describe('Total topics count', () => {
    it('should count all topics correctly', async () => {
      await Topic.insertMany([
        {
          topicName: 'Topic 1',
          subjectName: 'Math',
          dateStudied: new Date(),
          revisionDate: new Date(),
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
        {
          topicName: 'Topic 2',
          subjectName: 'Physics',
          dateStudied: new Date(),
          revisionDate: new Date(),
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
        {
          topicName: 'Topic 3',
          subjectName: 'Chemistry',
          dateStudied: new Date(),
          revisionDate: new Date(),
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
      ]);

      const response = await request(app).get('/api/statistics');

      expect(response.status).toBe(200);
      expect(response.body.totalTopics).toBe(3);
    });
  });

  describe('Due today count', () => {
    it('should count topics due today', async () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      await Topic.insertMany([
        {
          topicName: 'Overdue',
          subjectName: 'Math',
          dateStudied: new Date(),
          revisionDate: yesterday,
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
        {
          topicName: 'Due Today',
          subjectName: 'Physics',
          dateStudied: new Date(),
          revisionDate: now,
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
        {
          topicName: 'Not Due',
          subjectName: 'Chemistry',
          dateStudied: new Date(),
          revisionDate: tomorrow,
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
      ]);

      const response = await request(app).get('/api/statistics');

      expect(response.status).toBe(200);
      expect(response.body.dueToday).toBe(2); // Overdue + Due Today
    });
  });

  describe('Revised this week count', () => {
    it('should count topics revised in past 7 days', async () => {
      const now = new Date();
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

      // Create topics
      const topic1 = await Topic.create({
        topicName: 'Topic 1',
        subjectName: 'Math',
        dateStudied: new Date(),
        revisionDate: new Date(),
        eFactor: 2.5,
        repetitionNumber: 0,
        interval: 1,
      });

      const topic2 = await Topic.create({
        topicName: 'Topic 2',
        subjectName: 'Physics',
        dateStudied: new Date(),
        revisionDate: new Date(),
        eFactor: 2.5,
        repetitionNumber: 0,
        interval: 1,
      });

      const topic3 = await Topic.create({
        topicName: 'Topic 3',
        subjectName: 'Chemistry',
        dateStudied: new Date(),
        revisionDate: new Date(),
        eFactor: 2.5,
        repetitionNumber: 0,
        interval: 1,
      });

      // Create revision records
      await RevisionRecord.insertMany([
        {
          topicId: topic1._id,
          revisionDate: threeDaysAgo,
          userQuality: 4,
          llmQuality: 4,
          finalQuality: 4,
          previousEFactor: 2.5,
          newEFactor: 2.5,
          previousInterval: 1,
          newInterval: 6,
          nextRevisionDate: new Date(),
        },
        {
          topicId: topic2._id,
          revisionDate: now,
          userQuality: 5,
          llmQuality: 5,
          finalQuality: 5,
          previousEFactor: 2.5,
          newEFactor: 2.6,
          previousInterval: 1,
          newInterval: 6,
          nextRevisionDate: new Date(),
        },
        {
          topicId: topic3._id,
          revisionDate: tenDaysAgo,
          userQuality: 3,
          llmQuality: 3,
          finalQuality: 3,
          previousEFactor: 2.5,
          newEFactor: 2.36,
          previousInterval: 1,
          newInterval: 1,
          nextRevisionDate: new Date(),
        },
      ]);

      const response = await request(app).get('/api/statistics');

      expect(response.status).toBe(200);
      expect(response.body.revisedThisWeek).toBe(2); // topic1 and topic2
    });

    it('should count each topic only once even with multiple revisions', async () => {
      const now = new Date();
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
      const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

      const topic = await Topic.create({
        topicName: 'Topic 1',
        subjectName: 'Math',
        dateStudied: new Date(),
        revisionDate: new Date(),
        eFactor: 2.5,
        repetitionNumber: 0,
        interval: 1,
      });

      // Create multiple revision records for the same topic
      await RevisionRecord.insertMany([
        {
          topicId: topic._id,
          revisionDate: fiveDaysAgo,
          userQuality: 4,
          llmQuality: 4,
          finalQuality: 4,
          previousEFactor: 2.5,
          newEFactor: 2.5,
          previousInterval: 1,
          newInterval: 6,
          nextRevisionDate: new Date(),
        },
        {
          topicId: topic._id,
          revisionDate: twoDaysAgo,
          userQuality: 5,
          llmQuality: 5,
          finalQuality: 5,
          previousEFactor: 2.5,
          newEFactor: 2.6,
          previousInterval: 6,
          newInterval: 15,
          nextRevisionDate: new Date(),
        },
      ]);

      const response = await request(app).get('/api/statistics');

      expect(response.status).toBe(200);
      expect(response.body.revisedThisWeek).toBe(1); // Only count topic once
    });
  });

  describe('Revised this month count', () => {
    it('should count topics revised in past 30 days', async () => {
      const now = new Date();
      const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);
      const fortyDaysAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);

      const topic1 = await Topic.create({
        topicName: 'Topic 1',
        subjectName: 'Math',
        dateStudied: new Date(),
        revisionDate: new Date(),
        eFactor: 2.5,
        repetitionNumber: 0,
        interval: 1,
      });

      const topic2 = await Topic.create({
        topicName: 'Topic 2',
        subjectName: 'Physics',
        dateStudied: new Date(),
        revisionDate: new Date(),
        eFactor: 2.5,
        repetitionNumber: 0,
        interval: 1,
      });

      await RevisionRecord.insertMany([
        {
          topicId: topic1._id,
          revisionDate: fifteenDaysAgo,
          userQuality: 4,
          llmQuality: 4,
          finalQuality: 4,
          previousEFactor: 2.5,
          newEFactor: 2.5,
          previousInterval: 1,
          newInterval: 6,
          nextRevisionDate: new Date(),
        },
        {
          topicId: topic2._id,
          revisionDate: fortyDaysAgo,
          userQuality: 3,
          llmQuality: 3,
          finalQuality: 3,
          previousEFactor: 2.5,
          newEFactor: 2.36,
          previousInterval: 1,
          newInterval: 1,
          nextRevisionDate: new Date(),
        },
      ]);

      const response = await request(app).get('/api/statistics');

      expect(response.status).toBe(200);
      expect(response.body.revisedThisMonth).toBe(1); // Only topic1
    });
  });

  describe('Upcoming revisions', () => {
    it('should return upcoming revisions for next 7 days', async () => {
      const now = new Date();
      const tomorrow = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);
      const threeDaysLater = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
      const tenDaysLater = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);

      await Topic.insertMany([
        {
          topicName: 'Topic 1',
          subjectName: 'Math',
          dateStudied: new Date(),
          revisionDate: tomorrow,
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
        {
          topicName: 'Topic 2',
          subjectName: 'Physics',
          dateStudied: new Date(),
          revisionDate: threeDaysLater,
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
        {
          topicName: 'Topic 3',
          subjectName: 'Chemistry',
          dateStudied: new Date(),
          revisionDate: tenDaysLater,
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
      ]);

      const response = await request(app).get('/api/statistics');

      expect(response.status).toBe(200);
      expect(response.body.upcomingRevisions).toHaveLength(2); // Only next 7 days
    });

    it('should aggregate multiple topics on the same date', async () => {
      const now = new Date();
      const tomorrow = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);

      await Topic.insertMany([
        {
          topicName: 'Topic 1',
          subjectName: 'Math',
          dateStudied: new Date(),
          revisionDate: tomorrow,
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
        {
          topicName: 'Topic 2',
          subjectName: 'Physics',
          dateStudied: new Date(),
          revisionDate: tomorrow,
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
        {
          topicName: 'Topic 3',
          subjectName: 'Chemistry',
          dateStudied: new Date(),
          revisionDate: tomorrow,
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
      ]);

      const response = await request(app).get('/api/statistics');

      expect(response.status).toBe(200);
      expect(response.body.upcomingRevisions).toHaveLength(1);
      expect(response.body.upcomingRevisions[0].count).toBe(3);
    });

    it('should sort upcoming revisions by date', async () => {
      const now = new Date();
      const oneDayLater = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);
      const threeDaysLater = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
      const fiveDaysLater = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);

      await Topic.insertMany([
        {
          topicName: 'Topic 1',
          subjectName: 'Math',
          dateStudied: new Date(),
          revisionDate: fiveDaysLater,
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
        {
          topicName: 'Topic 2',
          subjectName: 'Physics',
          dateStudied: new Date(),
          revisionDate: oneDayLater,
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
        {
          topicName: 'Topic 3',
          subjectName: 'Chemistry',
          dateStudied: new Date(),
          revisionDate: threeDaysLater,
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
      ]);

      const response = await request(app).get('/api/statistics');

      expect(response.status).toBe(200);
      expect(response.body.upcomingRevisions).toHaveLength(3);
      
      // Verify dates are in ascending order
      const dates = response.body.upcomingRevisions.map((r: any) => r.date);
      expect(dates[0] < dates[1]).toBe(true);
      expect(dates[1] < dates[2]).toBe(true);
    });

    it('should return date in YYYY-MM-DD format', async () => {
      const now = new Date();
      const tomorrow = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);

      await Topic.create({
        topicName: 'Topic 1',
        subjectName: 'Math',
        dateStudied: new Date(),
        revisionDate: tomorrow,
        eFactor: 2.5,
        repetitionNumber: 0,
        interval: 1,
      });

      const response = await request(app).get('/api/statistics');

      expect(response.status).toBe(200);
      expect(response.body.upcomingRevisions).toHaveLength(1);
      expect(response.body.upcomingRevisions[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should not include topics due today or in the past', async () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);

      await Topic.insertMany([
        {
          topicName: 'Past Topic',
          subjectName: 'Math',
          dateStudied: new Date(),
          revisionDate: yesterday,
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
        {
          topicName: 'Today Topic',
          subjectName: 'Physics',
          dateStudied: new Date(),
          revisionDate: now,
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
      ]);

      const response = await request(app).get('/api/statistics');

      expect(response.status).toBe(200);
      expect(response.body.upcomingRevisions).toHaveLength(0);
    });
  });

  describe('Complete statistics', () => {
    it('should return accurate statistics for complex scenario', async () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      const twentyDaysAgo = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);
      const tomorrow = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);
      const threeDaysLater = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

      // Create topics
      const topic1 = await Topic.create({
        topicName: 'Topic 1',
        subjectName: 'Math',
        dateStudied: new Date(),
        revisionDate: yesterday,
        eFactor: 2.5,
        repetitionNumber: 0,
        interval: 1,
      });

      const topic2 = await Topic.create({
        topicName: 'Topic 2',
        subjectName: 'Physics',
        dateStudied: new Date(),
        revisionDate: tomorrow,
        eFactor: 2.5,
        repetitionNumber: 0,
        interval: 1,
      });

      await Topic.create({
        topicName: 'Topic 3',
        subjectName: 'Chemistry',
        dateStudied: new Date(),
        revisionDate: threeDaysLater,
        eFactor: 2.5,
        repetitionNumber: 0,
        interval: 1,
      });

      // Create revision records
      await RevisionRecord.insertMany([
        {
          topicId: topic1._id,
          revisionDate: threeDaysAgo,
          userQuality: 4,
          llmQuality: 4,
          finalQuality: 4,
          previousEFactor: 2.5,
          newEFactor: 2.5,
          previousInterval: 1,
          newInterval: 6,
          nextRevisionDate: new Date(),
        },
        {
          topicId: topic2._id,
          revisionDate: twentyDaysAgo,
          userQuality: 3,
          llmQuality: 3,
          finalQuality: 3,
          previousEFactor: 2.5,
          newEFactor: 2.36,
          previousInterval: 1,
          newInterval: 1,
          nextRevisionDate: new Date(),
        },
      ]);

      const response = await request(app).get('/api/statistics');

      expect(response.status).toBe(200);
      expect(response.body.totalTopics).toBe(3);
      expect(response.body.dueToday).toBe(1); // topic1
      expect(response.body.revisedThisWeek).toBe(1); // topic1
      expect(response.body.revisedThisMonth).toBe(2); // topic1 and topic2
      expect(response.body.upcomingRevisions).toHaveLength(2); // topic2 and topic3
      
      // Verify topic3 is included in upcoming revisions
      const upcomingDates = response.body.upcomingRevisions.map((r: any) => r.date);
      expect(upcomingDates.length).toBe(2);
    });
  });
});
