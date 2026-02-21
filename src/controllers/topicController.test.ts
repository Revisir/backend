import request from 'supertest';
import express from 'express';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import topicRoutes from '../routes/topicRoutes';
import { Topic } from '../models/Topic';

const app = express();
app.use(express.json());
app.use('/api/topics', topicRoutes);

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
});

describe('GET /api/topics', () => {
  describe('Pagination', () => {
    beforeEach(async () => {
      // Create 25 test topics
      const topics = [];
      for (let i = 1; i <= 25; i++) {
        topics.push({
          topicName: `Topic ${i}`,
          subjectName: 'Mathematics',
          description: `Description for topic ${i}`,
          dateStudied: new Date(),
          revisionDate: new Date(),
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        });
      }
      await Topic.insertMany(topics);
    });

    it('should return first page with default limit of 10', async () => {
      const response = await request(app).get('/api/topics');

      expect(response.status).toBe(200);
      expect(response.body.topics).toHaveLength(10);
      expect(response.body.total).toBe(25);
      expect(response.body.page).toBe(1);
    });

    it('should return second page with default limit', async () => {
      const response = await request(app).get('/api/topics?page=2');

      expect(response.status).toBe(200);
      expect(response.body.topics).toHaveLength(10);
      expect(response.body.total).toBe(25);
      expect(response.body.page).toBe(2);
    });

    it('should return third page with remaining items', async () => {
      const response = await request(app).get('/api/topics?page=3');

      expect(response.status).toBe(200);
      expect(response.body.topics).toHaveLength(5);
      expect(response.body.total).toBe(25);
      expect(response.body.page).toBe(3);
    });

    it('should respect custom limit parameter', async () => {
      const response = await request(app).get('/api/topics?limit=5');

      expect(response.status).toBe(200);
      expect(response.body.topics).toHaveLength(5);
      expect(response.body.total).toBe(25);
      expect(response.body.page).toBe(1);
    });

    it('should handle page and limit together', async () => {
      const response = await request(app).get('/api/topics?page=2&limit=7');

      expect(response.status).toBe(200);
      expect(response.body.topics).toHaveLength(7);
      expect(response.body.total).toBe(25);
      expect(response.body.page).toBe(2);
    });

    it('should return empty array for page beyond available data', async () => {
      const response = await request(app).get('/api/topics?page=10');

      expect(response.status).toBe(200);
      expect(response.body.topics).toHaveLength(0);
      expect(response.body.total).toBe(25);
      expect(response.body.page).toBe(10);
    });
  });

  describe('Validation', () => {
    it('should return 400 for invalid page parameter', async () => {
      const response = await request(app).get('/api/topics?page=invalid');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.message).toContain('Page must be a positive integer');
    });

    it('should return 400 for negative page parameter', async () => {
      const response = await request(app).get('/api/topics?page=-1');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.message).toContain('Page must be a positive integer');
    });

    it('should return 400 for zero page parameter', async () => {
      const response = await request(app).get('/api/topics?page=0');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.message).toContain('Page must be a positive integer');
    });

    it('should return 400 for invalid limit parameter', async () => {
      const response = await request(app).get('/api/topics?limit=invalid');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.message).toContain('Limit must be a positive integer');
    });

    it('should return 400 for limit exceeding maximum', async () => {
      const response = await request(app).get('/api/topics?limit=101');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.message).toContain('between 1 and 100');
    });

    it('should return 400 for zero limit parameter', async () => {
      const response = await request(app).get('/api/topics?limit=0');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.message).toContain('Limit must be a positive integer');
    });
  });

  describe('Subject filtering', () => {
    beforeEach(async () => {
      // Create topics with different subjects
      await Topic.insertMany([
        {
          topicName: 'Calculus',
          subjectName: 'Mathematics',
          dateStudied: new Date(),
          revisionDate: new Date(),
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
        {
          topicName: 'Algebra',
          subjectName: 'Mathematics',
          dateStudied: new Date(),
          revisionDate: new Date(),
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
        {
          topicName: 'Quantum Mechanics',
          subjectName: 'Physics',
          dateStudied: new Date(),
          revisionDate: new Date(),
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
        {
          topicName: 'Organic Chemistry',
          subjectName: 'Chemistry',
          dateStudied: new Date(),
          revisionDate: new Date(),
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
      ]);
    });

    it('should filter topics by subject', async () => {
      const response = await request(app).get('/api/topics?subject=Mathematics');

      expect(response.status).toBe(200);
      expect(response.body.topics).toHaveLength(2);
      expect(response.body.total).toBe(2);
      expect(response.body.topics.every((t: any) => t.subjectName === 'Mathematics')).toBe(true);
    });

    it('should return empty array for non-existent subject', async () => {
      const response = await request(app).get('/api/topics?subject=Biology');

      expect(response.status).toBe(200);
      expect(response.body.topics).toHaveLength(0);
      expect(response.body.total).toBe(0);
    });

    it('should combine subject filter with pagination', async () => {
      // Add more Mathematics topics
      await Topic.insertMany([
        {
          topicName: 'Geometry',
          subjectName: 'Mathematics',
          dateStudied: new Date(),
          revisionDate: new Date(),
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
        {
          topicName: 'Trigonometry',
          subjectName: 'Mathematics',
          dateStudied: new Date(),
          revisionDate: new Date(),
          eFactor: 2.5,
          repetitionNumber: 0,
          interval: 1,
        },
      ]);

      const response = await request(app).get('/api/topics?subject=Mathematics&limit=2&page=2');

      expect(response.status).toBe(200);
      expect(response.body.topics).toHaveLength(2);
      expect(response.body.total).toBe(4);
      expect(response.body.page).toBe(2);
    });

    it('should ignore empty subject parameter', async () => {
      const response = await request(app).get('/api/topics?subject=');

      expect(response.status).toBe(200);
      expect(response.body.total).toBe(4); // All topics
    });
  });

  describe('Sorting', () => {
    beforeEach(async () => {
      // Create topics with different creation times
      const topic1 = new Topic({
        topicName: 'Old Topic',
        subjectName: 'Mathematics',
        dateStudied: new Date('2023-01-01'),
        revisionDate: new Date(),
        eFactor: 2.5,
        repetitionNumber: 0,
        interval: 1,
      });
      await topic1.save();

      // Wait a bit to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));

      const topic2 = new Topic({
        topicName: 'New Topic',
        subjectName: 'Mathematics',
        dateStudied: new Date('2023-06-01'),
        revisionDate: new Date(),
        eFactor: 2.5,
        repetitionNumber: 0,
        interval: 1,
      });
      await topic2.save();
    });

    it('should return topics sorted by creation date (most recent first)', async () => {
      const response = await request(app).get('/api/topics');

      expect(response.status).toBe(200);
      expect(response.body.topics).toHaveLength(2);
      expect(response.body.topics[0].topicName).toBe('New Topic');
      expect(response.body.topics[1].topicName).toBe('Old Topic');
    });
  });

  describe('Empty database', () => {
    it('should return empty array when no topics exist', async () => {
      const response = await request(app).get('/api/topics');

      expect(response.status).toBe(200);
      expect(response.body.topics).toHaveLength(0);
      expect(response.body.total).toBe(0);
      expect(response.body.page).toBe(1);
    });
  });
});

describe('GET /api/topics/:id', () => {
  let testTopicId: string;

  beforeEach(async () => {
    // Create a test topic
    const topic = await Topic.create({
      topicName: 'Test Topic',
      subjectName: 'Mathematics',
      description: 'Test description',
      dateStudied: new Date('2024-01-01'),
      revisionDate: new Date('2024-01-02'),
      eFactor: 2.5,
      repetitionNumber: 0,
      interval: 1,
      files: [
        {
          fileName: 'test.pdf',
          fileType: 'pdf',
          fileUrl: 'https://example.com/test.pdf',
          s3Path: 'test-topic-id/extracted-content.md',
          s3Bucket: 'test-bucket',
          extractedContentUrl: 'https://s3.example.com/test-bucket/test-topic-id/extracted-content.md',
          processedAt: new Date(),
        },
      ],
    });
    testTopicId = topic._id.toString();
  });

  it('should return topic by valid ID', async () => {
    const response = await request(app).get(`/api/topics/${testTopicId}`);

    expect(response.status).toBe(200);
    expect(response.body._id).toBe(testTopicId);
    expect(response.body.topicName).toBe('Test Topic');
    expect(response.body.subjectName).toBe('Mathematics');
    expect(response.body.description).toBe('Test description');
    expect(response.body.eFactor).toBe(2.5);
    expect(response.body.repetitionNumber).toBe(0);
    expect(response.body.interval).toBe(1);
    expect(response.body.files).toHaveLength(1);
    expect(response.body.files[0].fileName).toBe('test.pdf');
  });

  it('should return 404 for non-existent topic ID', async () => {
    const nonExistentId = '507f1f77bcf86cd799439011'; // Valid ObjectId format but doesn't exist

    const response = await request(app).get(`/api/topics/${nonExistentId}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('TOPIC_NOT_FOUND');
    expect(response.body.error.message).toBe('Topic not found');
  });

  it('should return 400 for invalid topic ID format', async () => {
    const response = await request(app).get('/api/topics/invalid-id');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toBe('Invalid topic ID format');
  });

  it('should return 400 for empty topic ID', async () => {
    // Test with an ID that's too short (empty string gets URL encoded)
    const response = await request(app).get('/api/topics/abc');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 for too short ID', async () => {
    const response = await request(app).get('/api/topics/123');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toBe('Invalid topic ID format');
  });

  it('should return 400 for too long ID', async () => {
    const response = await request(app).get('/api/topics/507f1f77bcf86cd799439011abc');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toBe('Invalid topic ID format');
  });

  it('should return 400 for ID with invalid characters', async () => {
    const response = await request(app).get('/api/topics/507f1f77bcf86cd79943901g'); // 'g' is not a valid hex character

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toBe('Invalid topic ID format');
  });

  it('should return complete topic document with all fields', async () => {
    const response = await request(app).get(`/api/topics/${testTopicId}`);

    expect(response.status).toBe(200);
    
    // Verify all required fields are present
    expect(response.body).toHaveProperty('_id');
    expect(response.body).toHaveProperty('topicName');
    expect(response.body).toHaveProperty('subjectName');
    expect(response.body).toHaveProperty('description');
    expect(response.body).toHaveProperty('dateStudied');
    expect(response.body).toHaveProperty('revisionDate');
    expect(response.body).toHaveProperty('eFactor');
    expect(response.body).toHaveProperty('repetitionNumber');
    expect(response.body).toHaveProperty('interval');
    expect(response.body).toHaveProperty('files');
    expect(response.body).toHaveProperty('createdAt');
    expect(response.body).toHaveProperty('updatedAt');
  });

  it('should return topic with empty files array if no files attached', async () => {
    const topicWithoutFiles = await Topic.create({
      topicName: 'Topic Without Files',
      subjectName: 'Physics',
      dateStudied: new Date(),
      revisionDate: new Date(),
      eFactor: 2.5,
      repetitionNumber: 0,
      interval: 1,
      files: [],
    });

    const response = await request(app).get(`/api/topics/${topicWithoutFiles._id}`);

    expect(response.status).toBe(200);
    expect(response.body.files).toEqual([]);
  });
});

describe('GET /api/topics/due', () => {
  beforeEach(async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Create topics with various revision dates
    await Topic.insertMany([
      {
        topicName: 'Overdue Topic 1',
        subjectName: 'Mathematics',
        dateStudied: new Date('2024-01-01'),
        revisionDate: yesterday,
        eFactor: 2.5,
        repetitionNumber: 1,
        interval: 1,
      },
      {
        topicName: 'Due Today',
        subjectName: 'Physics',
        dateStudied: new Date('2024-01-02'),
        revisionDate: now,
        eFactor: 2.5,
        repetitionNumber: 0,
        interval: 1,
      },
      {
        topicName: 'Not Due Yet',
        subjectName: 'Chemistry',
        dateStudied: new Date('2024-01-03'),
        revisionDate: tomorrow,
        eFactor: 2.5,
        repetitionNumber: 0,
        interval: 1,
      },
      {
        topicName: 'Future Topic',
        subjectName: 'Biology',
        dateStudied: new Date('2024-01-04'),
        revisionDate: nextWeek,
        eFactor: 2.5,
        repetitionNumber: 0,
        interval: 1,
      },
    ]);
  });

  it('should return only topics that are due (revisionDate <= currentDate)', async () => {
    const response = await request(app).get('/api/topics/due');

    expect(response.status).toBe(200);
    expect(response.body.topics).toHaveLength(2);
    
    const topicNames = response.body.topics.map((t: any) => t.topicName);
    expect(topicNames).toContain('Overdue Topic 1');
    expect(topicNames).toContain('Due Today');
    expect(topicNames).not.toContain('Not Due Yet');
    expect(topicNames).not.toContain('Future Topic');
  });

  it('should sort due topics by revision date (oldest first)', async () => {
    const response = await request(app).get('/api/topics/due');

    expect(response.status).toBe(200);
    expect(response.body.topics).toHaveLength(2);
    
    // First topic should be the most overdue
    expect(response.body.topics[0].topicName).toBe('Overdue Topic 1');
    expect(response.body.topics[1].topicName).toBe('Due Today');
  });

  it('should return empty array when no topics are due', async () => {
    // Delete all topics and create only future topics
    await Topic.deleteMany({});
    
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await Topic.create({
      topicName: 'Future Topic',
      subjectName: 'Mathematics',
      dateStudied: new Date(),
      revisionDate: futureDate,
      eFactor: 2.5,
      repetitionNumber: 0,
      interval: 1,
    });

    const response = await request(app).get('/api/topics/due');

    expect(response.status).toBe(200);
    expect(response.body.topics).toHaveLength(0);
  });

  it('should return all topics when all are due', async () => {
    // Delete all topics and create only overdue topics
    await Topic.deleteMany({});
    
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await Topic.insertMany([
      {
        topicName: 'Due Topic 1',
        subjectName: 'Mathematics',
        dateStudied: new Date(),
        revisionDate: yesterday,
        eFactor: 2.5,
        repetitionNumber: 0,
        interval: 1,
      },
      {
        topicName: 'Due Topic 2',
        subjectName: 'Physics',
        dateStudied: new Date(),
        revisionDate: yesterday,
        eFactor: 2.5,
        repetitionNumber: 0,
        interval: 1,
      },
      {
        topicName: 'Due Topic 3',
        subjectName: 'Chemistry',
        dateStudied: new Date(),
        revisionDate: yesterday,
        eFactor: 2.5,
        repetitionNumber: 0,
        interval: 1,
      },
    ]);

    const response = await request(app).get('/api/topics/due');

    expect(response.status).toBe(200);
    expect(response.body.topics).toHaveLength(3);
  });

  it('should include topics with exact current date/time', async () => {
    await Topic.deleteMany({});
    
    const now = new Date();
    await Topic.create({
      topicName: 'Due Right Now',
      subjectName: 'Mathematics',
      dateStudied: new Date(),
      revisionDate: now,
      eFactor: 2.5,
      repetitionNumber: 0,
      interval: 1,
    });

    const response = await request(app).get('/api/topics/due');

    expect(response.status).toBe(200);
    expect(response.body.topics).toHaveLength(1);
    expect(response.body.topics[0].topicName).toBe('Due Right Now');
  });

  it('should return complete topic documents with all fields', async () => {
    const response = await request(app).get('/api/topics/due');

    expect(response.status).toBe(200);
    expect(response.body.topics.length).toBeGreaterThan(0);
    
    const topic = response.body.topics[0];
    expect(topic).toHaveProperty('_id');
    expect(topic).toHaveProperty('topicName');
    expect(topic).toHaveProperty('subjectName');
    expect(topic).toHaveProperty('dateStudied');
    expect(topic).toHaveProperty('revisionDate');
    expect(topic).toHaveProperty('eFactor');
    expect(topic).toHaveProperty('repetitionNumber');
    expect(topic).toHaveProperty('interval');
  });

  it('should handle database with no topics', async () => {
    await Topic.deleteMany({});

    const response = await request(app).get('/api/topics/due');

    expect(response.status).toBe(200);
    expect(response.body.topics).toEqual([]);
  });
});

describe('GET /api/topics/:id/history', () => {
  let testTopicId: string;

  beforeEach(async () => {
    // Create a test topic
    const topic = await Topic.create({
      topicName: 'Test Topic with History',
      subjectName: 'Mathematics',
      dateStudied: new Date('2024-01-01'),
      revisionDate: new Date('2024-01-02'),
      eFactor: 2.5,
      repetitionNumber: 0,
      interval: 1,
    });
    testTopicId = topic._id.toString();

    // Import RevisionRecord model
    const { RevisionRecord } = await import('../models/RevisionRecord');

    // Create revision history records
    await RevisionRecord.insertMany([
      {
        topicId: testTopicId,
        revisionDate: new Date('2024-01-10'),
        userQuality: 4,
        llmQuality: 4,
        finalQuality: 4,
        previousEFactor: 2.5,
        newEFactor: 2.5,
        previousInterval: 1,
        newInterval: 6,
        nextRevisionDate: new Date('2024-01-16'),
      },
      {
        topicId: testTopicId,
        revisionDate: new Date('2024-01-20'),
        userQuality: 5,
        llmQuality: 4,
        finalQuality: 4.5,
        previousEFactor: 2.5,
        newEFactor: 2.6,
        previousInterval: 6,
        newInterval: 15,
        nextRevisionDate: new Date('2024-02-04'),
      },
      {
        topicId: testTopicId,
        revisionDate: new Date('2024-01-05'),
        userQuality: 3,
        llmQuality: 3,
        finalQuality: 3,
        previousEFactor: 2.5,
        newEFactor: 2.36,
        previousInterval: 1,
        newInterval: 1,
        nextRevisionDate: new Date('2024-01-06'),
      },
    ]);
  });

  it('should return revision history for valid topic ID', async () => {
    const response = await request(app).get(`/api/topics/${testTopicId}/history`);

    expect(response.status).toBe(200);
    expect(response.body.history).toHaveLength(3);
  });

  it('should sort revision history by revisionDate descending (most recent first)', async () => {
    const response = await request(app).get(`/api/topics/${testTopicId}/history`);

    expect(response.status).toBe(200);
    expect(response.body.history).toHaveLength(3);
    
    // Check dates are in descending order
    const dates = response.body.history.map((r: any) => new Date(r.revisionDate).getTime());
    expect(dates[0]).toBeGreaterThan(dates[1]);
    expect(dates[1]).toBeGreaterThan(dates[2]);
    
    // Verify the order
    expect(new Date(response.body.history[0].revisionDate).toISOString()).toContain('2024-01-20');
    expect(new Date(response.body.history[1].revisionDate).toISOString()).toContain('2024-01-10');
    expect(new Date(response.body.history[2].revisionDate).toISOString()).toContain('2024-01-05');
  });

  it('should return complete revision record fields', async () => {
    const response = await request(app).get(`/api/topics/${testTopicId}/history`);

    expect(response.status).toBe(200);
    expect(response.body.history.length).toBeGreaterThan(0);
    
    const record = response.body.history[0];
    expect(record).toHaveProperty('_id');
    expect(record).toHaveProperty('topicId');
    expect(record).toHaveProperty('revisionDate');
    expect(record).toHaveProperty('userQuality');
    expect(record).toHaveProperty('llmQuality');
    expect(record).toHaveProperty('finalQuality');
    expect(record).toHaveProperty('previousEFactor');
    expect(record).toHaveProperty('newEFactor');
    expect(record).toHaveProperty('previousInterval');
    expect(record).toHaveProperty('newInterval');
    expect(record).toHaveProperty('nextRevisionDate');
    expect(record).toHaveProperty('createdAt');
  });

  it('should return empty array for topic with no revision history', async () => {
    // Create a new topic without history
    const newTopic = await Topic.create({
      topicName: 'New Topic',
      subjectName: 'Physics',
      dateStudied: new Date(),
      revisionDate: new Date(),
      eFactor: 2.5,
      repetitionNumber: 0,
      interval: 1,
    });

    const response = await request(app).get(`/api/topics/${newTopic._id}/history`);

    expect(response.status).toBe(200);
    expect(response.body.history).toEqual([]);
  });

  it('should return 404 for non-existent topic ID', async () => {
    const nonExistentId = '507f1f77bcf86cd799439011';

    const response = await request(app).get(`/api/topics/${nonExistentId}/history`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('TOPIC_NOT_FOUND');
    expect(response.body.error.message).toBe('Topic not found');
  });

  it('should return 400 for invalid topic ID format', async () => {
    const response = await request(app).get('/api/topics/invalid-id/history');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toBe('Invalid topic ID format');
  });

  it('should return 400 for too short ID', async () => {
    const response = await request(app).get('/api/topics/123/history');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 for ID with invalid characters', async () => {
    const response = await request(app).get('/api/topics/507f1f77bcf86cd79943901g/history');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should only return history for the specified topic', async () => {
    // Create another topic with its own history
    const { RevisionRecord } = await import('../models/RevisionRecord');
    
    const anotherTopic = await Topic.create({
      topicName: 'Another Topic',
      subjectName: 'Chemistry',
      dateStudied: new Date(),
      revisionDate: new Date(),
      eFactor: 2.5,
      repetitionNumber: 0,
      interval: 1,
    });

    await RevisionRecord.create({
      topicId: anotherTopic._id,
      revisionDate: new Date(),
      userQuality: 5,
      llmQuality: 5,
      finalQuality: 5,
      previousEFactor: 2.5,
      newEFactor: 2.6,
      previousInterval: 1,
      newInterval: 6,
      nextRevisionDate: new Date(),
    });

    // Get history for the first topic
    const response = await request(app).get(`/api/topics/${testTopicId}/history`);

    expect(response.status).toBe(200);
    expect(response.body.history).toHaveLength(3); // Only the 3 records for testTopicId
    
    // Verify all records belong to the correct topic
    response.body.history.forEach((record: any) => {
      expect(record.topicId).toBe(testTopicId);
    });
  });
});


// Mock the mind map generator service
jest.mock('../services/mindMapGenerator');

describe('POST /api/topics/:id/mindmap', () => {
  let testTopicId: string;

  beforeEach(async () => {
    // Create a test topic
    const topic = await Topic.create({
      topicName: 'Test Topic for Mind Map',
      subjectName: 'Mathematics',
      description: 'Test description',
      dateStudied: new Date(),
      revisionDate: new Date(),
      eFactor: 2.5,
      repetitionNumber: 0,
      interval: 1,
      files: [],
    });
    testTopicId = topic._id.toString();

    // Mock the generateMindMap function
    const { generateMindMap } = require('../services/mindMapGenerator');
    generateMindMap.mockResolvedValue(`mindmap
  root(Test Topic for Mind Map)
    Key Concept 1
      Detail A
      Detail B
    Key Concept 2
      Detail C`);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should generate a mind map successfully', async () => {
    const response = await request(app).post(`/api/topics/${testTopicId}/mindmap`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('mindmap');
    expect(response.body).toHaveProperty('generatedAt');
    expect(response.body.mindmap).toContain('mindmap');
    expect(response.body.mindmap).toContain('root(Test Topic for Mind Map)');
  });

  it('should store mind map in MongoDB', async () => {
    await request(app).post(`/api/topics/${testTopicId}/mindmap`);

    const topic = await Topic.findById(testTopicId);
    expect(topic?.mindMap).toBeTruthy();
    expect(topic?.mindMap).toContain('mindmap');
    expect(topic?.mindMapGeneratedAt).toBeTruthy();
  });

  it('should return 400 for invalid topic ID format', async () => {
    const response = await request(app).post('/api/topics/invalid-id/mindmap');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toBe('Invalid topic ID format');
  });

  it('should return 404 for non-existent topic', async () => {
    const nonExistentId = '507f1f77bcf86cd799439011';

    const response = await request(app).post(`/api/topics/${nonExistentId}/mindmap`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('TOPIC_NOT_FOUND');
  });

  it('should update existing mind map when regenerated', async () => {
    // Generate first mind map
    await request(app).post(`/api/topics/${testTopicId}/mindmap`);
    
    const firstTopic = await Topic.findById(testTopicId);
    const firstMindMap = firstTopic?.mindMap;
    const firstGeneratedAt = firstTopic?.mindMapGeneratedAt;

    // Wait a bit to ensure different timestamp
    await new Promise(resolve => setTimeout(resolve, 10));

    // Mock a different mind map
    const { generateMindMap } = require('../services/mindMapGenerator');
    generateMindMap.mockResolvedValue(`mindmap
  root(Updated Mind Map)
    New Concept`);

    // Generate second mind map
    await request(app).post(`/api/topics/${testTopicId}/mindmap`);

    const secondTopic = await Topic.findById(testTopicId);
    expect(secondTopic?.mindMap).not.toBe(firstMindMap);
    expect(secondTopic?.mindMapGeneratedAt?.getTime()).toBeGreaterThan(firstGeneratedAt!.getTime());
  });
});

describe('GET /api/topics/:id/mindmap', () => {
  let testTopicId: string;
  let topicWithoutMindMap: string;

  beforeEach(async () => {
    // Create a topic with a mind map
    const topicWithMindMap = await Topic.create({
      topicName: 'Topic With Mind Map',
      subjectName: 'Mathematics',
      dateStudied: new Date(),
      revisionDate: new Date(),
      eFactor: 2.5,
      repetitionNumber: 0,
      interval: 1,
      mindMap: `mindmap
  root(Topic With Mind Map)
    Concept 1
    Concept 2`,
      mindMapGeneratedAt: new Date(),
    });
    testTopicId = topicWithMindMap._id.toString();

    // Create a topic without a mind map
    const topicWithout = await Topic.create({
      topicName: 'Topic Without Mind Map',
      subjectName: 'Physics',
      dateStudied: new Date(),
      revisionDate: new Date(),
      eFactor: 2.5,
      repetitionNumber: 0,
      interval: 1,
    });
    topicWithoutMindMap = topicWithout._id.toString();
  });

  it('should retrieve existing mind map', async () => {
    const response = await request(app).get(`/api/topics/${testTopicId}/mindmap`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('mindmap');
    expect(response.body).toHaveProperty('generatedAt');
    expect(response.body.mindmap).toContain('mindmap');
    expect(response.body.mindmap).toContain('root(Topic With Mind Map)');
  });

  it('should return 404 when mind map does not exist', async () => {
    const response = await request(app).get(`/api/topics/${topicWithoutMindMap}/mindmap`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('MINDMAP_NOT_FOUND');
    expect(response.body.error.message).toContain('not been generated');
  });

  it('should return 400 for invalid topic ID format', async () => {
    const response = await request(app).get('/api/topics/invalid-id/mindmap');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 404 for non-existent topic', async () => {
    const nonExistentId = '507f1f77bcf86cd799439011';

    const response = await request(app).get(`/api/topics/${nonExistentId}/mindmap`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('TOPIC_NOT_FOUND');
  });

  it('should return generatedAt timestamp', async () => {
    const response = await request(app).get(`/api/topics/${testTopicId}/mindmap`);

    expect(response.status).toBe(200);
    expect(response.body.generatedAt).toBeTruthy();
    expect(new Date(response.body.generatedAt).getTime()).toBeGreaterThan(0);
  });
});
