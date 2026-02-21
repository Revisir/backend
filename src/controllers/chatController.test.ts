import request from 'supertest';
import express from 'express';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import chatRoutes from '../routes/chatRoutes';
import { Topic } from '../models/Topic';
import { ChatSession } from '../models/ChatSession';
import { RevisionRecord } from '../models/RevisionRecord';

// Mock the services
jest.mock('../services/chatContext');
jest.mock('../services/llmClient');
jest.mock('../services/s3Storage');

const app = express();
app.use(express.json());
app.use('/api/chat', chatRoutes);

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
  await ChatSession.deleteMany({});
  await RevisionRecord.deleteMany({});
  jest.clearAllMocks();
});

describe('POST /api/chat/start', () => {
  let testTopicId: string;

  beforeEach(async () => {
    // Create a test topic
    const topic = await Topic.create({
      topicName: 'Test Topic',
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

    // Mock the services
    const { buildChatContext } = require('../services/chatContext');
    const { getLLMClient } = require('../services/llmClient');
    
    buildChatContext.mockResolvedValue('Mock context prompt');
    getLLMClient.mockReturnValue({
      sendTextPrompt: jest.fn().mockResolvedValue('Hello! Let\'s start your revision session.'),
    });
  });

  it('should start a chat session successfully', async () => {
    const response = await request(app)
      .post('/api/chat/start')
      .send({ topicId: testTopicId });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('sessionId');
    expect(response.body).toHaveProperty('initialMessage');
    expect(response.body.initialMessage).toBe('Hello! Let\'s start your revision session.');
  });

  it('should create a ChatSession document in MongoDB', async () => {
    const response = await request(app)
      .post('/api/chat/start')
      .send({ topicId: testTopicId });

    expect(response.status).toBe(200);

    const chatSession = await ChatSession.findById(response.body.sessionId);
    expect(chatSession).toBeTruthy();
    expect(chatSession?.topicId.toString()).toBe(testTopicId);
    expect(chatSession?.active).toBe(true);
    expect(chatSession?.messages).toHaveLength(1);
    expect(chatSession?.messages[0].role).toBe('assistant');
  });

  it('should return 400 for invalid topic ID format', async () => {
    const response = await request(app)
      .post('/api/chat/start')
      .send({ topicId: 'invalid-id' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toBe('Invalid topic ID format');
  });

  it('should return 404 for non-existent topic', async () => {
    const nonExistentId = '507f1f77bcf86cd799439011';

    const response = await request(app)
      .post('/api/chat/start')
      .send({ topicId: nonExistentId });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('TOPIC_NOT_FOUND');
  });

  it('should return 400 for missing topicId', async () => {
    const response = await request(app)
      .post('/api/chat/start')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/chat/message', () => {
  let testSessionId: string;

  beforeEach(async () => {
    // Create a test topic
    const topic = await Topic.create({
      topicName: 'Test Topic',
      subjectName: 'Mathematics',
      dateStudied: new Date(),
      revisionDate: new Date(),
      eFactor: 2.5,
      repetitionNumber: 0,
      interval: 1,
    });

    // Create a test chat session
    const chatSession = await ChatSession.create({
      topicId: topic._id,
      messages: [
        {
          role: 'assistant',
          content: 'Hello! Let\'s start.',
          timestamp: new Date(),
        },
      ],
      active: true,
    });
    testSessionId = chatSession._id.toString();

    // Mock LLM client
    const { getLLMClient } = require('../services/llmClient');
    getLLMClient.mockReturnValue({
      sendTextPrompt: jest.fn().mockResolvedValue('That\'s a great answer!'),
    });
  });

  it('should send a message and receive a response', async () => {
    const response = await request(app)
      .post('/api/chat/message')
      .send({
        sessionId: testSessionId,
        message: 'What is 2+2?',
      });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('response');
    expect(response.body.response).toBe('That\'s a great answer!');
  });

  it('should append messages to chat session', async () => {
    await request(app)
      .post('/api/chat/message')
      .send({
        sessionId: testSessionId,
        message: 'What is 2+2?',
      });

    const chatSession = await ChatSession.findById(testSessionId);
    expect(chatSession?.messages).toHaveLength(3); // Initial + user + assistant
    expect(chatSession?.messages[1].role).toBe('user');
    expect(chatSession?.messages[1].content).toBe('What is 2+2?');
    expect(chatSession?.messages[2].role).toBe('assistant');
  });

  it('should return 400 for invalid session ID format', async () => {
    const response = await request(app)
      .post('/api/chat/message')
      .send({
        sessionId: 'invalid-id',
        message: 'Test message',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 404 for non-existent session', async () => {
    const nonExistentId = '507f1f77bcf86cd799439011';

    const response = await request(app)
      .post('/api/chat/message')
      .send({
        sessionId: nonExistentId,
        message: 'Test message',
      });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('SESSION_INVALID');
  });

  it('should return 400 for empty message', async () => {
    const response = await request(app)
      .post('/api/chat/message')
      .send({
        sessionId: testSessionId,
        message: '',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 for inactive session', async () => {
    // Mark session as inactive
    await ChatSession.findByIdAndUpdate(testSessionId, { active: false });

    const response = await request(app)
      .post('/api/chat/message')
      .send({
        sessionId: testSessionId,
        message: 'Test message',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('SESSION_INVALID');
    expect(response.body.error.message).toContain('no longer active');
  });
});

describe('POST /api/chat/complete', () => {
  let testTopicId: string;
  let testSessionId: string;

  beforeEach(async () => {
    // Create a test topic
    const topic = await Topic.create({
      topicName: 'Test Topic',
      subjectName: 'Mathematics',
      dateStudied: new Date('2024-01-01'),
      revisionDate: new Date('2024-01-02'),
      eFactor: 2.5,
      repetitionNumber: 0,
      interval: 1,
    });
    testTopicId = topic._id.toString();

    // Create a test chat session
    const chatSession = await ChatSession.create({
      topicId: topic._id,
      messages: [
        {
          role: 'assistant',
          content: 'Hello!',
          timestamp: new Date(),
        },
        {
          role: 'user',
          content: 'Hi!',
          timestamp: new Date(),
        },
      ],
      active: true,
    });
    testSessionId = chatSession._id.toString();
  });

  it('should complete a chat session successfully', async () => {
    const response = await request(app)
      .post('/api/chat/complete')
      .send({
        sessionId: testSessionId,
        topicId: testTopicId,
        userQuality: 4,
        llmQuality: 4,
      });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('nextRevisionDate');
    expect(response.body).toHaveProperty('finalQuality');
    expect(response.body.finalQuality).toBe(4); // (4+4)/2
  });

  it('should update topic with new revision schedule', async () => {
    const originalTopic = await Topic.findById(testTopicId);
    const originalRevisionDate = originalTopic?.revisionDate;

    await request(app)
      .post('/api/chat/complete')
      .send({
        sessionId: testSessionId,
        topicId: testTopicId,
        userQuality: 5,
        llmQuality: 5,
      });

    const topic = await Topic.findById(testTopicId);
    expect(topic?.eFactor).toBe(2.5); // Capped at 2.5
    expect(topic?.repetitionNumber).toBe(1); // Should increment from 0 to 1
    expect(topic?.interval).toBe(1); // First repetition interval is 1
    expect(topic?.revisionDate.getTime()).toBeGreaterThan(originalRevisionDate!.getTime()); // Should be updated
  });

  it('should create a revision record', async () => {
    await request(app)
      .post('/api/chat/complete')
      .send({
        sessionId: testSessionId,
        topicId: testTopicId,
        userQuality: 4,
        llmQuality: 5,
      });

    const revisionRecords = await RevisionRecord.find({ topicId: testTopicId });
    expect(revisionRecords).toHaveLength(1);
    expect(revisionRecords[0].userQuality).toBe(4);
    expect(revisionRecords[0].llmQuality).toBe(5);
    expect(revisionRecords[0].finalQuality).toBe(4.5);
    expect(revisionRecords[0].previousEFactor).toBe(2.5);
  });

  it('should mark chat session as inactive', async () => {
    await request(app)
      .post('/api/chat/complete')
      .send({
        sessionId: testSessionId,
        topicId: testTopicId,
        userQuality: 4,
        llmQuality: 4,
      });

    const chatSession = await ChatSession.findById(testSessionId);
    expect(chatSession?.active).toBe(false);
    expect(chatSession?.completedAt).toBeTruthy();
  });

  it('should calculate correct final quality', async () => {
    const response = await request(app)
      .post('/api/chat/complete')
      .send({
        sessionId: testSessionId,
        topicId: testTopicId,
        userQuality: 3,
        llmQuality: 5,
      });

    expect(response.status).toBe(200);
    expect(response.body.finalQuality).toBe(4); // (3+5)/2
  });

  it('should return 400 for invalid session ID', async () => {
    const response = await request(app)
      .post('/api/chat/complete')
      .send({
        sessionId: 'invalid-id',
        topicId: testTopicId,
        userQuality: 4,
        llmQuality: 4,
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 for invalid topic ID', async () => {
    const response = await request(app)
      .post('/api/chat/complete')
      .send({
        sessionId: testSessionId,
        topicId: 'invalid-id',
        userQuality: 4,
        llmQuality: 4,
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 400 for invalid userQuality', async () => {
    const response = await request(app)
      .post('/api/chat/complete')
      .send({
        sessionId: testSessionId,
        topicId: testTopicId,
        userQuality: 6, // Out of range
        llmQuality: 4,
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toContain('User quality');
  });

  it('should return 400 for invalid llmQuality', async () => {
    const response = await request(app)
      .post('/api/chat/complete')
      .send({
        sessionId: testSessionId,
        topicId: testTopicId,
        userQuality: 4,
        llmQuality: -1, // Out of range
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toContain('LLM quality');
  });

  it('should return 404 for non-existent session', async () => {
    const nonExistentId = '507f1f77bcf86cd799439011';

    const response = await request(app)
      .post('/api/chat/complete')
      .send({
        sessionId: nonExistentId,
        topicId: testTopicId,
        userQuality: 4,
        llmQuality: 4,
      });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('SESSION_INVALID');
  });

  it('should return 404 for non-existent topic', async () => {
    const nonExistentId = '507f1f77bcf86cd799439011';

    const response = await request(app)
      .post('/api/chat/complete')
      .send({
        sessionId: testSessionId,
        topicId: nonExistentId,
        userQuality: 4,
        llmQuality: 4,
      });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('TOPIC_NOT_FOUND');
  });
});
