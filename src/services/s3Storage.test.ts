import {
  saveExtractedContent,
  getExtractedContent,
  getSignedContentUrl,
  fileExists,
  S3StorageError,
  S3ErrorCode,
} from './s3Storage';
import { s3Client, S3_BUCKET_NAME } from '../config/s3';
import { mockClient } from 'aws-sdk-client-mock';
import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Mock the S3 client
const s3Mock = mockClient(s3Client);

// Mock getSignedUrl
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

describe('S3 Storage Operations', () => {
  beforeEach(() => {
    s3Mock.reset();
    jest.clearAllMocks();
  });

  describe('saveExtractedContent', () => {
    it('should save content to S3 with correct path format', async () => {
      const userId = 'test-user-123';
      const topicId = '507f1f77bcf86cd799439011';
      const content = '# Test Content\n\nThis is test markdown content.';

      s3Mock.on(PutObjectCommand).resolves({});

      const result = await saveExtractedContent(userId, topicId, content);

      expect(result).toBe(`${userId}/${topicId}/extracted-content.md`);
      expect(s3Mock.calls()).toHaveLength(1);
      
      const call = s3Mock.call(0);
      const input = call.args[0].input as any;
      expect(input).toMatchObject({
        Bucket: S3_BUCKET_NAME,
        Key: `${userId}/${topicId}/extracted-content.md`,
        Body: content,
        ContentType: 'text/markdown',
      });
      expect(input.Metadata).toHaveProperty('userId', userId);
      expect(input.Metadata).toHaveProperty('topicId', topicId);
      expect(input.Metadata).toHaveProperty('uploadedAt');
    });

    it('should throw error for invalid topicId (empty string)', async () => {
      await expect(saveExtractedContent('user-123', '', 'content')).rejects.toThrow(
        S3StorageError
      );
      // Empty topicId results in path with double slashes
      await expect(saveExtractedContent('user-123', '', 'content')).rejects.toThrow(
        'S3 path contains invalid characters or patterns'
      );
    });

    it('should throw error for invalid topicId (path traversal)', async () => {
      await expect(
        saveExtractedContent('user-123', '../malicious', 'content')
      ).rejects.toThrow(S3StorageError);
      await expect(
        saveExtractedContent('user-123', '../malicious', 'content')
      ).rejects.toThrow('S3 path contains invalid characters or patterns');
    });

    it('should throw error for empty content', async () => {
      await expect(
        saveExtractedContent('user-123', '507f1f77bcf86cd799439011', '')
      ).rejects.toThrow(S3StorageError);
      await expect(
        saveExtractedContent('user-123', '507f1f77bcf86cd799439011', '')
      ).rejects.toThrow('Content must be a non-empty string');
    });

    it('should retry on transient S3 errors', async () => {
      const userId = 'test-user-123';
      const topicId = '507f1f77bcf86cd799439011';
      const content = 'Test content';

      // Fail twice, then succeed
      s3Mock
        .on(PutObjectCommand)
        .rejectsOnce(new Error('Network error'))
        .rejectsOnce(new Error('Timeout'))
        .resolvesOnce({});

      const result = await saveExtractedContent(userId, topicId, content);

      expect(result).toBe(`${userId}/${topicId}/extracted-content.md`);
      expect(s3Mock.calls()).toHaveLength(3);
    });

    it('should throw S3StorageError after max retries', async () => {
      const userId = 'test-user-123';
      const topicId = '507f1f77bcf86cd799439011';
      const content = 'Test content';

      s3Mock.reset(); // Reset mock before this test
      s3Mock.on(PutObjectCommand).rejects(new Error('Persistent error'));

      await expect(saveExtractedContent(userId, topicId, content)).rejects.toThrow(
        S3StorageError
      );
      
      // Should have tried 3 times
      expect(s3Mock.calls()).toHaveLength(3);
    }, 10000); // Increase timeout for retry delays
  });

  describe('getExtractedContent', () => {
    it('should retrieve content from S3', async () => {
      const userId = 'test-user-123';
      const s3Path = 'test-user-123/507f1f77bcf86cd799439011/extracted-content.md';
      const expectedContent = '# Test Content\n\nRetrieved content.';

      s3Mock.on(GetObjectCommand).resolves({
        Body: {
          transformToString: async () => expectedContent,
        } as any,
      });

      const result = await getExtractedContent(userId, s3Path);

      expect(result).toBe(expectedContent);
      expect(s3Mock.calls()).toHaveLength(1);
      
      const call = s3Mock.call(0);
      expect(call.args[0].input).toMatchObject({
        Bucket: S3_BUCKET_NAME,
        Key: s3Path,
      });
    });

    it('should throw error for unauthorized access (wrong userId)', async () => {
      const userId = 'test-user-123';
      const s3Path = 'different-user/507f1f77bcf86cd799439011/extracted-content.md';

      await expect(getExtractedContent(userId, s3Path)).rejects.toThrow(S3StorageError);
      await expect(getExtractedContent(userId, s3Path)).rejects.toThrow(
        'Unauthorized access to S3 content'
      );
    });

    it('should throw error for invalid s3Path', async () => {
      const userId = 'test-user-123';
      await expect(getExtractedContent(userId, '')).rejects.toThrow(S3StorageError);
      await expect(getExtractedContent(userId, '../invalid')).rejects.toThrow(
        S3StorageError
      );
      await expect(getExtractedContent(userId, '/absolute/path')).rejects.toThrow(
        S3StorageError
      );
    });

    it('should throw error when S3 response body is empty', async () => {
      const userId = 'test-user-123';
      const s3Path = 'test-user-123/507f1f77bcf86cd799439011/extracted-content.md';

      s3Mock.on(GetObjectCommand).resolves({
        Body: undefined,
      });

      await expect(getExtractedContent(userId, s3Path)).rejects.toThrow(
        S3StorageError
      );
      await expect(getExtractedContent(userId, s3Path)).rejects.toMatchObject({
        code: S3ErrorCode.DOWNLOAD_FAILED,
      });
    }, 10000); // Increase timeout for retry delays

    it('should retry on transient S3 errors', async () => {
      const userId = 'test-user-123';
      const s3Path = 'test-user-123/507f1f77bcf86cd799439011/extracted-content.md';
      const expectedContent = 'Retrieved content';

      // Fail twice, then succeed
      s3Mock
        .on(GetObjectCommand)
        .rejectsOnce(new Error('Network error'))
        .rejectsOnce(new Error('Timeout'))
        .resolvesOnce({
          Body: {
            transformToString: async () => expectedContent,
          } as any,
        });

      const result = await getExtractedContent(userId, s3Path);

      expect(result).toBe(expectedContent);
      expect(s3Mock.calls()).toHaveLength(3);
    });

    it('should throw S3StorageError after max retries', async () => {
      const userId = 'test-user-123';
      const s3Path = 'test-user-123/507f1f77bcf86cd799439011/extracted-content.md';

      s3Mock.reset(); // Reset mock before this test
      s3Mock.on(GetObjectCommand).rejects(new Error('Persistent error'));

      await expect(getExtractedContent(userId, s3Path)).rejects.toThrow(
        S3StorageError
      );
      
      // Should have tried 3 times
      expect(s3Mock.calls()).toHaveLength(3);
    }, 10000); // Increase timeout for retry delays
  });

  describe('getSignedContentUrl', () => {
    it('should generate signed URL with default expiration', async () => {
      const s3Path = '507f1f77bcf86cd799439011/extracted-content.md';
      const expectedUrl = 'https://s3.amazonaws.com/signed-url';

      (getSignedUrl as jest.Mock).mockResolvedValue(expectedUrl);

      const result = await getSignedContentUrl(s3Path);

      expect(result).toBe(expectedUrl);
      expect(getSignedUrl).toHaveBeenCalledWith(
        s3Client,
        expect.any(GetObjectCommand),
        { expiresIn: 3600 }
      );
    });

    it('should generate signed URL with custom expiration', async () => {
      const s3Path = '507f1f77bcf86cd799439011/extracted-content.md';
      const expectedUrl = 'https://s3.amazonaws.com/signed-url';
      const customExpiration = 7200; // 2 hours

      (getSignedUrl as jest.Mock).mockResolvedValue(expectedUrl);

      const result = await getSignedContentUrl(s3Path, customExpiration);

      expect(result).toBe(expectedUrl);
      expect(getSignedUrl).toHaveBeenCalledWith(
        s3Client,
        expect.any(GetObjectCommand),
        { expiresIn: customExpiration }
      );
    });

    it('should throw error for invalid s3Path', async () => {
      await expect(getSignedContentUrl('')).rejects.toThrow(S3StorageError);
      await expect(getSignedContentUrl('../invalid')).rejects.toThrow(
        S3StorageError
      );
    });

    it('should throw error for invalid expiration (too short)', async () => {
      const s3Path = '507f1f77bcf86cd799439011/extracted-content.md';

      await expect(getSignedContentUrl(s3Path, 0)).rejects.toThrow(
        S3StorageError
      );
      await expect(getSignedContentUrl(s3Path, -100)).rejects.toThrow(
        S3StorageError
      );
    });

    it('should throw error for invalid expiration (too long)', async () => {
      const s3Path = '507f1f77bcf86cd799439011/extracted-content.md';
      const tooLong = 604801; // More than 7 days

      await expect(getSignedContentUrl(s3Path, tooLong)).rejects.toThrow(
        S3StorageError
      );
      await expect(getSignedContentUrl(s3Path, tooLong)).rejects.toThrow(
        'expiresIn must be between 1 and 604800 seconds'
      );
    });

    it('should throw S3StorageError when URL generation fails', async () => {
      const s3Path = '507f1f77bcf86cd799439011/extracted-content.md';

      (getSignedUrl as jest.Mock).mockRejectedValue(
        new Error('Failed to generate URL')
      );

      await expect(getSignedContentUrl(s3Path)).rejects.toThrow(
        S3StorageError
      );
      await expect(getSignedContentUrl(s3Path)).rejects.toMatchObject({
        code: S3ErrorCode.ACCESS_ERROR,
      });
    });
  });

  describe('fileExists', () => {
    it('should return true when file exists', async () => {
      const s3Path = '507f1f77bcf86cd799439011/extracted-content.md';

      s3Mock.on(HeadObjectCommand).resolves({});

      const result = await fileExists(s3Path);

      expect(result).toBe(true);
      expect(s3Mock.calls()).toHaveLength(1);
      
      const call = s3Mock.call(0);
      expect(call.args[0].input).toMatchObject({
        Bucket: S3_BUCKET_NAME,
        Key: s3Path,
      });
    });

    it('should return false when file does not exist (NotFound error)', async () => {
      const s3Path = '507f1f77bcf86cd799439011/extracted-content.md';

      const notFoundError = new Error('Not Found');
      (notFoundError as any).name = 'NotFound';
      s3Mock.on(HeadObjectCommand).rejects(notFoundError);

      const result = await fileExists(s3Path);

      expect(result).toBe(false);
    });

    it('should return false when file does not exist (404 status)', async () => {
      const s3Path = '507f1f77bcf86cd799439011/extracted-content.md';

      const notFoundError = new Error('Not Found');
      (notFoundError as any).$metadata = { httpStatusCode: 404 };
      s3Mock.on(HeadObjectCommand).rejects(notFoundError);

      const result = await fileExists(s3Path);

      expect(result).toBe(false);
    });

    it('should return false for other S3 errors', async () => {
      const s3Path = '507f1f77bcf86cd799439011/extracted-content.md';

      s3Mock.on(HeadObjectCommand).rejects(new Error('Access Denied'));

      const result = await fileExists(s3Path);

      expect(result).toBe(false);
    });

    it('should throw error for invalid s3Path', async () => {
      await expect(fileExists('')).rejects.toThrow(S3StorageError);
      await expect(fileExists('../invalid')).rejects.toThrow(S3StorageError);
    });
  });

  describe('Error Handling', () => {
    it('should create S3StorageError with correct properties', () => {
      const originalError = new Error('Original error');
      const error = new S3StorageError(
        S3ErrorCode.UPLOAD_FAILED,
        'Upload failed',
        originalError
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(S3StorageError);
      expect(error.name).toBe('S3StorageError');
      expect(error.code).toBe(S3ErrorCode.UPLOAD_FAILED);
      expect(error.message).toBe('Upload failed');
      expect(error.originalError).toBe(originalError);
    });

    it('should create S3StorageError without original error', () => {
      const error = new S3StorageError(
        S3ErrorCode.INVALID_PATH,
        'Invalid path'
      );

      expect(error.code).toBe(S3ErrorCode.INVALID_PATH);
      expect(error.message).toBe('Invalid path');
      expect(error.originalError).toBeUndefined();
    });
  });

  describe('Graceful Degradation', () => {
    it('should handle S3 unavailability gracefully in saveExtractedContent', async () => {
      const userId = 'test-user-123';
      const topicId = '507f1f77bcf86cd799439011';
      const content = 'Test content';

      s3Mock.on(PutObjectCommand).rejects(new Error('S3 unavailable'));

      await expect(saveExtractedContent(userId, topicId, content)).rejects.toThrow(
        S3StorageError
      );
      
      // Error should be logged and thrown, allowing caller to handle gracefully
      const error = await saveExtractedContent(userId, topicId, content).catch(
        (e) => e
      );
      expect(error).toBeInstanceOf(S3StorageError);
      expect(error.code).toBe(S3ErrorCode.UPLOAD_FAILED);
    }, 10000); // Increase timeout for retry delays

    it('should handle S3 unavailability gracefully in getExtractedContent', async () => {
      const userId = 'test-user-123';
      const s3Path = 'test-user-123/507f1f77bcf86cd799439011/extracted-content.md';

      s3Mock.on(GetObjectCommand).rejects(new Error('S3 unavailable'));

      await expect(getExtractedContent(userId, s3Path)).rejects.toThrow(
        S3StorageError
      );
      
      // Error should be logged and thrown, allowing caller to handle gracefully
      const error = await getExtractedContent(userId, s3Path).catch((e) => e);
      expect(error).toBeInstanceOf(S3StorageError);
      expect(error.code).toBe(S3ErrorCode.DOWNLOAD_FAILED);
    }, 10000); // Increase timeout for retry delays
  });
});
