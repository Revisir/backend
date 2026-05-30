import { S3Client } from "@aws-sdk/client-s3";
import * as Minio from "minio";

// const isProduction = process.env.NODE_ENV === 'production';
export const useMinio = process.env.BUCKET_TYPE === "minio";

/**
 * Creates an S3 client configured for either AWS S3 (production) or MinIO (development).
 *
 * Production (NODE_ENV=production):
 * - Uses AWS S3 with credentials from AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY
 * - Region from AWS_REGION (defaults to us-east-1)
 *
 * Development (NODE_ENV=development or not set):
 * - Uses MinIO with S3-compatible API
 * - Endpoint from MINIO_ENDPOINT:MINIO_PORT (defaults to localhost:9000)
 * - Credentials from MINIO_ACCESS_KEY and MINIO_SECRET_KEY (defaults to minioadmin)
 * - Supports SSL via MINIO_USE_SSL environment variable
 *
 * @returns Configured S3Client instance
 */
export const createS3Client = (): S3Client => {
  if (!useMinio) {
    // AWS S3 Configuration for Production
    return new S3Client({
      region: process.env.AWS_REGION || "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      },
    });
  } else {
    // MinIO Configuration for Local Development
    // Using AWS SDK v3 S3Client with MinIO-compatible configuration
    const minioEndpoint = process.env.MINIO_ENDPOINT || "localhost";
    const minioPort = process.env.MINIO_PORT || "9000";
    const minioUseSSL = process.env.MINIO_USE_SSL === "true";

    return new S3Client({
      region: "us-east-1", // MinIO requires a region but doesn't use it
      endpoint: `http${minioUseSSL ? "s" : ""}://${minioEndpoint}:${minioPort}`,
      credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY || "minioadmin",
        secretAccessKey: process.env.MINIO_SECRET_KEY || "minioadmin",
      },
      forcePathStyle: true, // Required for MinIO compatibility
    });
  }
};

/**
 * Singleton S3 client instance.
 * Automatically configured based on NODE_ENV.
 */
export const s3Client = createS3Client();

/**
 * S3 bucket name for storing extracted content.
 * Defaults to 'revision-study-content' if not specified.
 */
export const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || "revision-study-content";

/**
 * MinIO client instance (only for MinIO-specific APIs like bucket notifications).
 * null in production.
 */
export const minioClient = useMinio
  ? new Minio.Client({
      endPoint: process.env.MINIO_ENDPOINT || "localhost",
      port: parseInt(process.env.MINIO_PORT || "9000"),
      useSSL: process.env.MINIO_USE_SSL === "true",
      accessKey: process.env.MINIO_ACCESS_KEY || "minioadmin",
      secretKey: process.env.MINIO_SECRET_KEY || "minioadmin",
    })
  : null;
