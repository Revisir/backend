import { ChatSession } from './ChatSession';

/**
 * Basic unit tests for ChatSession schema
 * These tests verify the schema structure and validation without requiring a database connection
 */

describe('ChatSession Schema', () => {
  describe('Schema Structure', () => {
    it('should have all required fields defined', () => {
      const schema = ChatSession.schema;
      
      // Check required fields exist
      expect(schema.path('topicId')).toBeDefined();
      expect(schema.path('startedAt')).toBeDefined();
      expect(schema.path('completedAt')).toBeDefined();
      expect(schema.path('messages')).toBeDefined();
      expect(schema.path('active')).toBeDefined();
    });

    it('should have correct field types', () => {
      const schema = ChatSession.schema;
      
      expect(schema.path('topicId').instance).toBe('ObjectId');
      expect(schema.path('startedAt').instance).toBe('Date');
      expect(schema.path('completedAt').instance).toBe('Date');
      expect(schema.path('messages').instance).toBe('Array');
      expect(schema.path('active').instance).toBe('Boolean');
    });

    it('should have correct default values', () => {
      const schema = ChatSession.schema;
      
      expect(schema.path('completedAt').defaultValue).toBe(null);
      expect(schema.path('active').defaultValue).toBe(true);
      expect(typeof schema.path('startedAt').defaultValue).toBe('function'); // Date.now is a function
    });

    it('should have topicId as required field', () => {
      const schema = ChatSession.schema;
      const topicIdPath = schema.path('topicId');
      
      expect(topicIdPath.isRequired).toBe(true);
    });

    it('should reference Topic collection', () => {
      const schema = ChatSession.schema;
      const topicIdPath = schema.path('topicId') as any;
      
      expect(topicIdPath.options.ref).toBe('Topic');
    });
  });

  describe('Message Subdocument Schema', () => {
    it('should have message subdocument with correct fields', () => {
      const schema = ChatSession.schema;
      const messagesPath = schema.path('messages') as any;
      const messageSchema = messagesPath.schema;
      
      expect(messageSchema.path('role')).toBeDefined();
      expect(messageSchema.path('content')).toBeDefined();
      expect(messageSchema.path('timestamp')).toBeDefined();
    });

    it('should have correct field types in message subdocument', () => {
      const schema = ChatSession.schema;
      const messagesPath = schema.path('messages') as any;
      const messageSchema = messagesPath.schema;
      
      expect(messageSchema.path('role').instance).toBe('String');
      expect(messageSchema.path('content').instance).toBe('String');
      expect(messageSchema.path('timestamp').instance).toBe('Date');
    });

    it('should have role enum with user and assistant values', () => {
      const schema = ChatSession.schema;
      const messagesPath = schema.path('messages') as any;
      const messageSchema = messagesPath.schema;
      const rolePath = messageSchema.path('role');
      
      expect(rolePath.enumValues).toContain('user');
      expect(rolePath.enumValues).toContain('assistant');
      expect(rolePath.enumValues).toHaveLength(2);
    });

    it('should have all message fields as required', () => {
      const schema = ChatSession.schema;
      const messagesPath = schema.path('messages') as any;
      const messageSchema = messagesPath.schema;
      
      expect(messageSchema.path('role').isRequired).toBe(true);
      expect(messageSchema.path('content').isRequired).toBe(true);
    });

    it('should have timestamp with default value', () => {
      const schema = ChatSession.schema;
      const messagesPath = schema.path('messages') as any;
      const messageSchema = messagesPath.schema;
      
      expect(typeof messageSchema.path('timestamp').defaultValue).toBe('function'); // Date.now is a function
    });

    it('should not have _id field in message subdocument', () => {
      const schema = ChatSession.schema;
      const messagesPath = schema.path('messages') as any;
      const messageSchema = messagesPath.schema;
      
      expect(messageSchema.options._id).toBe(false);
    });
  });

  describe('Indexes', () => {
    it('should have compound index on topicId and active', () => {
      const indexes = ChatSession.schema.indexes();
      const compoundIndex = indexes.find(
        (index: any) => 
          index[0].topicId === 1 && 
          index[0].active === 1
      );
      
      expect(compoundIndex).toBeDefined();
    });
  });
});
