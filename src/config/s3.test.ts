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

  describe('AWS S3 Configuration', () => {
    it('should create S3 client with AWS credentials when BUCKET_TYPE is not seaweedfs', () => {
      delete process.env.BUCKET_TYPE;
      process.env.AWS_REGION = 'us-west-2';
      process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
      process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';

      const client = createS3Client();

      expect(client).toBeInstanceOf(S3Client);
      expect(client.config.region).toBeDefined();
    });

    it('should use default region if AWS_REGION not provided', () => {
      delete process.env.BUCKET_TYPE;
      process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
      process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
      delete process.env.AWS_REGION;

      const client = createS3Client();

      expect(client).toBeInstanceOf(S3Client);
    });

    it('should handle missing AWS credentials gracefully', () => {
      delete process.env.BUCKET_TYPE;
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;

      const client = createS3Client();

      expect(client).toBeInstanceOf(S3Client);
    });
  });

  describe('SeaweedFS Configuration', () => {
    // `useSeaweedFS` is read when the module first loads, so BUCKET_TYPE has to
    // be set before a fresh require — the createS3Client imported at the top of
    // this file is bound to whatever the env said at import time.
    function freshClient(): S3Client {
      jest.resetModules();
      const { createS3Client: create } = require('./s3');
      return create();
    }

    it('should create S3 client with SeaweedFS configuration', () => {
      process.env.BUCKET_TYPE = 'seaweedfs';
      process.env.S3_ENDPOINT = 'localhost';
      process.env.S3_PORT = '8333';
      process.env.S3_USE_SSL = 'false';
      process.env.S3_ACCESS_KEY = 'seaweedfsadmin';
      process.env.S3_SECRET_KEY = 'seaweedfssecret';

      const client = freshClient();

      // Not toBeInstanceOf: resetModules hands back a fresh copy of the SDK, so
      // its S3Client is a different class object than the one imported above.
      expect(client.constructor.name).toBe('S3Client');
      expect(client.config.region).toBeDefined();
    });

    it('should use default SeaweedFS settings if not provided', async () => {
      process.env.BUCKET_TYPE = 'seaweedfs';
      delete process.env.S3_ENDPOINT;
      delete process.env.S3_PORT;
      delete process.env.S3_USE_SSL;
      delete process.env.S3_ACCESS_KEY;
      delete process.env.S3_SECRET_KEY;

      const endpoint = await freshClient().config.endpoint!();

      expect(endpoint.hostname).toBe('localhost');
      expect(endpoint.port).toBe(8333);
    });

    it('should configure forcePathStyle for SeaweedFS compatibility', () => {
      process.env.BUCKET_TYPE = 'seaweedfs';

      const client = freshClient();

      expect(client.config.forcePathStyle).toBe(true);
    });

    it('should resolve the endpoint from S3_ENDPOINT and S3_PORT', async () => {
      process.env.BUCKET_TYPE = 'seaweedfs';
      process.env.S3_ENDPOINT = 'seaweedfs';
      process.env.S3_PORT = '8333';
      process.env.S3_USE_SSL = 'false';

      const endpoint = await freshClient().config.endpoint!();

      expect(endpoint.protocol).toBe('http:');
      expect(endpoint.hostname).toBe('seaweedfs');
      expect(endpoint.port).toBe(8333);
    });

    it('should support SSL for SeaweedFS when enabled', async () => {
      process.env.BUCKET_TYPE = 'seaweedfs';
      process.env.S3_USE_SSL = 'true';
      process.env.S3_ENDPOINT = 'seaweedfs.example.com';
      process.env.S3_PORT = '8333';

      const endpoint = await freshClient().config.endpoint!();

      expect(endpoint.protocol).toBe('https:');
      expect(endpoint.hostname).toBe('seaweedfs.example.com');
    });

    it('should not calculate request checksums, which SeaweedFS reads from the presigned query', async () => {
      process.env.BUCKET_TYPE = 'seaweedfs';

      const client = freshClient();

      await expect(client.config.requestChecksumCalculation()).resolves.toBe('WHEN_REQUIRED');
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

  describe('BUCKET_TYPE-based Configuration Switching', () => {
    it('should switch to SeaweedFS when BUCKET_TYPE is seaweedfs', () => {
      process.env.BUCKET_TYPE = 'seaweedfs';

      jest.resetModules();
      const { useSeaweedFS } = require('./s3');

      expect(useSeaweedFS).toBe(true);
    });

    it('should switch to AWS S3 for any other BUCKET_TYPE', () => {
      process.env.BUCKET_TYPE = 's3';

      jest.resetModules();
      const { useSeaweedFS } = require('./s3');

      expect(useSeaweedFS).toBe(false);
    });

    it('should default to AWS S3 when BUCKET_TYPE is not set', () => {
      delete process.env.BUCKET_TYPE;

      jest.resetModules();
      const { useSeaweedFS } = require('./s3');

      expect(useSeaweedFS).toBe(false);
    });
  });
});
