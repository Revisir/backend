import { Topic, IAttachedFile } from './Topic';

/**
 * Basic unit tests for Topic schema
 * These tests verify the schema structure and validation without requiring a database connection
 */

describe('Topic Schema', () => {
  describe('Schema Structure', () => {
    it('should have all required fields defined', () => {
      const schema = Topic.schema;
      
      // Check required fields exist
      expect(schema.path('topicName')).toBeDefined();
      expect(schema.path('subjectName')).toBeDefined();
      expect(schema.path('dateStudied')).toBeDefined();
      expect(schema.path('revisionDate')).toBeDefined();
      expect(schema.path('eFactor')).toBeDefined();
      expect(schema.path('repetitionNumber')).toBeDefined();
      expect(schema.path('interval')).toBeDefined();
      expect(schema.path('files')).toBeDefined();
    });

    it('should have correct field types', () => {
      const schema = Topic.schema;
      
      expect(schema.path('topicName').instance).toBe('String');
      expect(schema.path('subjectName').instance).toBe('String');
      expect(schema.path('description').instance).toBe('String');
      expect(schema.path('dateStudied').instance).toBe('Date');
      expect(schema.path('revisionDate').instance).toBe('Date');
      expect(schema.path('eFactor').instance).toBe('Number');
      expect(schema.path('repetitionNumber').instance).toBe('Number');
      expect(schema.path('interval').instance).toBe('Number');
    });

    it('should have correct default values', () => {
      const schema = Topic.schema;
      
      expect(schema.path('description').defaultValue).toBe('');
      expect(schema.path('eFactor').defaultValue).toBe(2.5);
      expect(schema.path('repetitionNumber').defaultValue).toBe(0);
      expect(schema.path('interval').defaultValue).toBe(1);
      expect(schema.path('mindMap').defaultValue).toBe(null);
      expect(schema.path('mindMapGeneratedAt').defaultValue).toBe(null);
    });

    it('should have correct validation constraints', () => {
      const schema = Topic.schema;
      
      // Check maxlength
      expect(schema.path('topicName').options.maxlength).toBe(200);
      expect(schema.path('subjectName').options.maxlength).toBe(100);
      
      // Check min/max for numbers
      expect(schema.path('eFactor').options.min).toBe(1.3);
      expect(schema.path('eFactor').options.max).toBe(2.5);
      expect(schema.path('repetitionNumber').options.min).toBe(0);
      expect(schema.path('interval').options.min).toBe(1);
    });

    it('should have timestamps enabled', () => {
      const schema = Topic.schema;
      expect(schema.options.timestamps).toBe(true);
    });

    it('should have correct indexes', () => {
      const indexes = Topic.schema.indexes();
      
      // Check that indexes exist
      const indexPaths = indexes.map((idx: any) => Object.keys(idx[0])[0]);
      expect(indexPaths).toContain('revisionDate');
      expect(indexPaths).toContain('subjectName');
      expect(indexPaths).toContain('createdAt');
    });
  });

  describe('AttachedFile Subdocument', () => {
    it('should have all required fields', () => {
      const filesPath = Topic.schema.path('files') as any;
      const fileSchema = filesPath.schema;
      
      expect(fileSchema.path('fileName')).toBeDefined();
      expect(fileSchema.path('fileType')).toBeDefined();
      expect(fileSchema.path('fileUrl')).toBeDefined();
      expect(fileSchema.path('s3Path')).toBeDefined();
      expect(fileSchema.path('s3Bucket')).toBeDefined();
      expect(fileSchema.path('extractedContentUrl')).toBeDefined();
      expect(fileSchema.path('processedAt')).toBeDefined();
    });

    it('should have correct fileType enum values', () => {
      const filesPath = Topic.schema.path('files') as any;
      const fileSchema = filesPath.schema;
      const fileTypeOptions = fileSchema.path('fileType').options;
      
      expect(fileTypeOptions.enum).toEqual(['image', 'pdf', 'url', 'text']);
    });
  });

  describe('Virtual Fields', () => {
    it('should have isDue virtual field', () => {
      const virtuals = Topic.schema.virtuals;
      expect(virtuals.isDue).toBeDefined();
    });

    it('should calculate isDue correctly for past dates', () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);
      
      const topic = new Topic({
        topicName: 'Test Topic',
        subjectName: 'Test Subject',
        dateStudied: new Date(),
        revisionDate: pastDate
      });
      
      expect(topic.isDue).toBe(true);
    });

    it('should calculate isDue correctly for future dates', () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 1);
      
      const topic = new Topic({
        topicName: 'Test Topic',
        subjectName: 'Test Subject',
        dateStudied: new Date(),
        revisionDate: futureDate
      });
      
      expect(topic.isDue).toBe(false);
    });

    it('should calculate isDue correctly for today', () => {
      const today = new Date();
      
      const topic = new Topic({
        topicName: 'Test Topic',
        subjectName: 'Test Subject',
        dateStudied: new Date(),
        revisionDate: today
      });
      
      // Should be true since revisionDate <= currentDate
      expect(topic.isDue).toBe(true);
    });
  });

  describe('Document Creation', () => {
    it('should create a topic with required fields', () => {
      const topicData = {
        topicName: 'JavaScript Basics',
        subjectName: 'Programming',
        dateStudied: new Date('2024-01-01'),
        revisionDate: new Date('2024-01-02')
      };
      
      const topic = new Topic(topicData);
      
      expect(topic.topicName).toBe(topicData.topicName);
      expect(topic.subjectName).toBe(topicData.subjectName);
      expect(topic.dateStudied).toEqual(topicData.dateStudied);
      expect(topic.revisionDate).toEqual(topicData.revisionDate);
    });

    it('should apply default values', () => {
      const topic = new Topic({
        topicName: 'Test Topic',
        subjectName: 'Test Subject',
        dateStudied: new Date(),
        revisionDate: new Date()
      });
      
      expect(topic.description).toBe('');
      expect(topic.eFactor).toBe(2.5);
      expect(topic.repetitionNumber).toBe(0);
      expect(topic.interval).toBe(1);
      expect(topic.files).toEqual([]);
      expect(topic.mindMap).toBe(null);
      expect(topic.mindMapGeneratedAt).toBe(null);
    });

    it('should create a topic with optional fields', () => {
      const topicData = {
        topicName: 'Advanced TypeScript',
        subjectName: 'Programming',
        description: 'Advanced TypeScript concepts including generics and decorators',
        dateStudied: new Date('2024-01-01'),
        revisionDate: new Date('2024-01-02'),
        eFactor: 2.0,
        repetitionNumber: 3,
        interval: 10
      };
      
      const topic = new Topic(topicData);
      
      expect(topic.description).toBe(topicData.description);
      expect(topic.eFactor).toBe(topicData.eFactor);
      expect(topic.repetitionNumber).toBe(topicData.repetitionNumber);
      expect(topic.interval).toBe(topicData.interval);
    });

    it('should create a topic with attached files', () => {
      const fileData: IAttachedFile = {
        fileName: 'notes.pdf',
        fileType: 'pdf',
        fileUrl: 'https://example.com/notes.pdf',
        s3Path: '507f1f77bcf86cd799439011/extracted-content.md',
        s3Bucket: 'revision-study-content',
        extractedContentUrl: 'https://s3.amazonaws.com/revision-study-content/507f1f77bcf86cd799439011/extracted-content.md',
        processedAt: new Date()
      };
      
      const topic = new Topic({
        topicName: 'Test Topic',
        subjectName: 'Test Subject',
        dateStudied: new Date(),
        revisionDate: new Date(),
        files: [fileData]
      });
      
      expect(topic.files).toHaveLength(1);
      expect(topic.files[0].fileName).toBe(fileData.fileName);
      expect(topic.files[0].fileType).toBe(fileData.fileType);
      expect(topic.files[0].s3Path).toBe(fileData.s3Path);
    });
  });

  describe('JSON Serialization', () => {
    it('should include virtual fields in JSON output', () => {
      const topic = new Topic({
        topicName: 'Test Topic',
        subjectName: 'Test Subject',
        dateStudied: new Date(),
        revisionDate: new Date()
      });
      
      const json = topic.toJSON();
      expect(json.isDue).toBeDefined();
    });

    it('should include virtual fields in object output', () => {
      const topic = new Topic({
        topicName: 'Test Topic',
        subjectName: 'Test Subject',
        dateStudied: new Date(),
        revisionDate: new Date()
      });
      
      const obj = topic.toObject();
      expect(obj.isDue).toBeDefined();
    });
  });
});
