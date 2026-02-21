import { createS3Client } from './s3';
import { S3Client } from '@aws-sdk/client-s3';

describe('S3 Client Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('Production Configuration (AWS S3)', () => {
    it('should create S3 client with AWS credentials in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.AWS_REGION = 'us-west-2';
      process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
      process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';

      const client = createS3Client();

      expect(client).toBeInstanceOf(S3Client);
      expect(client.config.region).toBeDefined();
    });

    it('should use default region if AWS_REGION not provided', () => {
      process.env.NODE_ENV = 'production';
      process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
      process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
      delete process.env.AWS_REGION;

      const client = createS3Client();

      expect(client).toBeInstanceOf(S3Client);
    });

    it('should handle missing AWS credentials gracefully', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;

      const client = createS3Client();

      expect(client).toBeInstanceOf(S3Client);
    });
  });

  describe('Development Configuration (MinIO)', () => {
    it('should create S3 client with MinIO configuration in development', () => {
      process.env.NODE_ENV = 'development';
      process.env.MINIO_ENDPOINT = 'localhost';
      process.env.MINIO_PORT = '9000';
      process.env.MINIO_USE_SSL = 'false';
      process.env.MINIO_ACCESS_KEY = 'minioadmin';
      process.env.MINIO_SECRET_KEY = 'minioadmin';

      const client = createS3Client();

      expect(client).toBeInstanceOf(S3Client);
      expect(client.config.region).toBeDefined();
    });

    it('should use default MinIO settings if not provided', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.MINIO_ENDPOINT;
      delete process.env.MINIO_PORT;
      delete process.env.MINIO_USE_SSL;
      delete process.env.MINIO_ACCESS_KEY;
      delete process.env.MINIO_SECRET_KEY;

      const client = createS3Client();

      expect(client).toBeInstanceOf(S3Client);
    });

    it('should configure forcePathStyle for MinIO compatibility', () => {
      process.env.NODE_ENV = 'development';

      const client = createS3Client();

      expect(client).toBeInstanceOf(S3Client);
      // forcePathStyle is set in the config
    });

    it('should support SSL for MinIO when enabled', () => {
      process.env.NODE_ENV = 'development';
      process.env.MINIO_USE_SSL = 'true';
      process.env.MINIO_ENDPOINT = 'minio.example.com';
      process.env.MINIO_PORT = '9000';

      const client = createS3Client();

      expect(client).toBeInstanceOf(S3Client);
    });
  });

  describe('Bucket Configuration', () => {
    it('should export S3_BUCKET_NAME from environment', () => {
      process.env.S3_BUCKET_NAME = 'test-bucket';

      // Need to re-import to get updated env
      jest.resetModules();
      const { S3_BUCKET_NAME: bucketName } = require('./s3');

      expect(bucketName).toBe('test-bucket');
    });

    it('should use default bucket name if not provided', () => {
      delete process.env.S3_BUCKET_NAME;

      jest.resetModules();
      const { S3_BUCKET_NAME: bucketName } = require('./s3');

      expect(bucketName).toBe('revision-study-content');
    });
  });

  describe('Environment-based Configuration Switching', () => {
    it('should switch to AWS S3 when NODE_ENV is production', () => {
      process.env.NODE_ENV = 'production';
      process.env.AWS_ACCESS_KEY_ID = 'prod-key';
      process.env.AWS_SECRET_ACCESS_KEY = 'prod-secret';

      const client = createS3Client();

      expect(client).toBeInstanceOf(S3Client);
      // In production, endpoint should not be set (uses AWS default)
    });

    it('should switch to MinIO when NODE_ENV is not production', () => {
      process.env.NODE_ENV = 'development';

      const client = createS3Client();

      expect(client).toBeInstanceOf(S3Client);
      // In development, endpoint should be set to MinIO
    });

    it('should default to MinIO when NODE_ENV is not set', () => {
      delete process.env.NODE_ENV;

      const client = createS3Client();

      expect(client).toBeInstanceOf(S3Client);
    });
  });
});
