import { PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client, S3_BUCKET_NAME } from "../config/s3";
import * as Minio from "minio";

const useMinio = process.env.BUCKET_TYPE === "minio";

// MinIO client for presigned URLs (only in development)
const minioClient = useMinio
  ? new Minio.Client({
      endPoint: process.env.MINIO_ENDPOINT || "localhost",
      port: parseInt(process.env.MINIO_PORT || "9000"),
      useSSL: process.env.MINIO_USE_SSL === "true",
      accessKey: process.env.MINIO_ACCESS_KEY || "minioadmin",
      secretKey: process.env.MINIO_SECRET_KEY || "minioadmin",
    })
  : null;

/**
 * Error codes for S3 operations
 */
export enum S3ErrorCode {
  UPLOAD_FAILED = "S3_UPLOAD_FAILED",
  DOWNLOAD_FAILED = "S3_DOWNLOAD_FAILED",
  ACCESS_ERROR = "S3_ACCESS_ERROR",
  INVALID_PATH = "S3_INVALID_PATH",
}

/**
 * Custom error class for S3 operations
 */
export class S3StorageError extends Error {
  constructor(
    public code: S3ErrorCode,
    message: string,
    public originalError?: Error,
  ) {
    super(message);
    this.name = "S3StorageError";
  }
}

/**
 * Retry configuration for S3 operations
 */
const RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
};

/**
 * Sleep utility for retry delays
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry wrapper for S3 operations with exponential backoff
 */
async function retryOperation<T>(operation: () => Promise<T>, errorCode: S3ErrorCode, errorMessage: string): Promise<T> {
  let lastError: Error | undefined;
  let delay = RETRY_CONFIG.initialDelayMs;

  for (let attempt = 0; attempt < RETRY_CONFIG.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      console.error(`S3 operation attempt ${attempt + 1}/${RETRY_CONFIG.maxRetries} failed:`, error);

      // Don't retry on the last attempt
      if (attempt < RETRY_CONFIG.maxRetries - 1) {
        await sleep(delay);
        delay *= RETRY_CONFIG.backoffMultiplier;
      }
    }
  }

  throw new S3StorageError(errorCode, errorMessage, lastError);
}

/**
 * Validates S3 path format
 */
function validateS3Path(s3Path: string): void {
  // Check for empty or non-string first
  if (typeof s3Path !== "string" || s3Path.trim() === "") {
    throw new S3StorageError(S3ErrorCode.INVALID_PATH, "S3 path must be a non-empty string");
  }

  // Check for invalid characters or patterns
  if (s3Path.includes("..") || s3Path.startsWith("/")) {
    throw new S3StorageError(S3ErrorCode.INVALID_PATH, "S3 path contains invalid characters or patterns");
  }
}

/**
 * Generates a presigned URL for uploading files to S3/MinIO.
 * Path format: {userId}/{topicId}/files/{fileName}
 *
 * @param userId - Cognito user ID
 * @param topicId - MongoDB ObjectId of the topic
 * @param fileName - Original file name
 * @param contentType - MIME type of the file
 * @param expiresIn - URL expiration time in seconds (default: 3600)
 * @returns Presigned URL for uploading the file
 */
export async function generatePresignedUploadUrl(userId: string, topicId: string, fileName: string, contentType: string, expiresIn: number = 3600): Promise<string> {
  const s3Path = `${userId}/${topicId}/files/${fileName}`;
  validateS3Path(s3Path);

  try {
    if (!useMinio) {
      // AWS S3 presigned URL
      const command = new PutObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: s3Path,
        ContentType: contentType,
      });
      const url = await getSignedUrl(s3Client, command, { expiresIn });
      console.log(`Generated AWS presigned upload URL for: ${s3Path}`);
      return url;
    } else {
      // MinIO presigned URL (metadata added by Lambda after upload)
      const url = await minioClient!.presignedPutObject(S3_BUCKET_NAME, s3Path, expiresIn);
      console.log(`Generated MinIO presigned upload URL for: ${s3Path}`);
      return url;
    }
  } catch (error) {
    throw new S3StorageError(S3ErrorCode.ACCESS_ERROR, `Failed to generate presigned upload URL for: ${s3Path}`, error as Error);
  }
}

/**
 * Saves extracted content to S3 as markdown file.
 * Path format: {userId}/{topicId}/extracted-content.md
 *
 * @param userId - Cognito user ID
 * @param topicId - MongoDB ObjectId of the topic
 * @param content - Extracted content as markdown text
 * @returns S3 path where content was saved
 * @throws S3StorageError if upload fails after retries
 */
export async function saveExtractedContent(userId: string, topicId: string, content: string): Promise<string> {
  const s3Path = `${userId}/${topicId}/extracted-content.md`;

  validateS3Path(s3Path);

  if (!content || typeof content !== "string") {
    throw new S3StorageError(S3ErrorCode.UPLOAD_FAILED, "Content must be a non-empty string");
  }

  await retryOperation(
    async () => {
      const command = new PutObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: s3Path,
        Body: content,
        ContentType: "text/markdown",
        Metadata: {
          userId,
          topicId,
          uploadedAt: new Date().toISOString(),
        },
      });

      await s3Client.send(command);
    },
    S3ErrorCode.UPLOAD_FAILED,
    `Failed to upload content to S3 at path: ${s3Path}`,
  );

  console.log(`Successfully saved content to S3: ${s3Path}`);
  return s3Path;
}

/**
 * Retrieves extracted content from S3.
 * Validates that the path starts with the userId for security.
 *
 * @param userId - Cognito user ID (for security validation)
 * @param s3Path - S3 path to the content file
 * @returns Extracted content as string
 * @throws S3StorageError if download fails after retries or unauthorized access
 */
export async function getExtractedContent(userId: string, s3Path: string): Promise<string> {
  validateS3Path(s3Path);

  // Security check: ensure path starts with userId
  if (!s3Path.startsWith(`${userId}/`)) {
    throw new S3StorageError(S3ErrorCode.ACCESS_ERROR, "Unauthorized access to S3 content");
  }

  const content = await retryOperation(
    async () => {
      const command = new GetObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: s3Path,
      });

      const response = await s3Client.send(command);

      if (!response.Body) {
        throw new Error("S3 response body is empty");
      }

      // Convert stream to string
      const content = await response.Body.transformToString();
      return content;
    },
    S3ErrorCode.DOWNLOAD_FAILED,
    `Failed to retrieve content from S3 at path: ${s3Path}`,
  );

  console.log(`Successfully retrieved content from S3: ${s3Path}`);
  return content;
}

/**
 * Generates a signed URL for frontend access to S3/MinIO content.
 * URL expires after 1 hour (3600 seconds).
 *
 * @param s3Path - S3 path to the content file
 * @param expiresIn - URL expiration time in seconds (default: 3600)
 * @returns Signed URL for accessing the content
 * @throws S3StorageError if URL generation fails
 */
export async function getSignedContentUrl(s3Path: string, expiresIn: number = 3600): Promise<string> {
  validateS3Path(s3Path);

  if (expiresIn <= 0 || expiresIn > 604800) {
    // Max 7 days
    throw new S3StorageError(S3ErrorCode.INVALID_PATH, "expiresIn must be between 1 and 604800 seconds (7 days)");
  }

  try {
    if (!useMinio) {
      // AWS S3 presigned URL
      const command = new GetObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: s3Path,
      });
      const url = await getSignedUrl(s3Client, command, { expiresIn });
      console.log(`Generated AWS signed URL for S3 path: ${s3Path}`);
      return url;
    } else {
      // MinIO presigned URL
      const url = await minioClient!.presignedGetObject(S3_BUCKET_NAME, s3Path, expiresIn);
      console.log(`Generated MinIO signed URL for S3 path: ${s3Path}`);
      return url;
    }
  } catch (error) {
    throw new S3StorageError(S3ErrorCode.ACCESS_ERROR, `Failed to generate signed URL for path: ${s3Path}`, error as Error);
  }
}

/**
 * Checks if a file exists in S3.
 * Useful for validation before attempting retrieval.
 *
 * @param s3Path - S3 path to check
 * @returns true if file exists, false otherwise
 */
export async function fileExists(s3Path: string): Promise<boolean> {
  validateS3Path(s3Path);

  try {
    const command = new HeadObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: s3Path,
    });

    await s3Client.send(command);
    return true;
  } catch (error: any) {
    // If error is 404 (NotFound), file doesn't exist
    if (error.name === "NotFound" || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    // For other errors, log and return false
    console.error(`Error checking file existence for ${s3Path}:`, error);
    return false;
  }
}

/**
 * Deletes a single file from S3/MinIO
 *
 * @param userId - Cognito user ID
 * @param topicId - MongoDB ObjectId of the topic
 * @param fileName - Name of the file to delete
 */
export async function deleteFile(userId: string, topicId: string, fileName: string): Promise<void> {
  const s3Path = `${userId}/${topicId}/files/${fileName}`;
  validateS3Path(s3Path);

  try {
    if (!useMinio) {
      const deleteCommand = new DeleteObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: s3Path,
      });
      await s3Client.send(deleteCommand);
    } else {
      await minioClient!.removeObject(S3_BUCKET_NAME, s3Path);
    }
    console.log(`Deleted file: ${s3Path}`);
  } catch (error) {
    console.error(`Error deleting file ${s3Path}:`, error);
    throw new S3StorageError(S3ErrorCode.ACCESS_ERROR, `Failed to delete file: ${s3Path}`, error as Error);
  }
}

/**
 * Deletes all files in a topic folder (userId/topicId/)
 *
 * @param userId - Cognito user ID
 * @param topicId - MongoDB ObjectId of the topic
 */
export async function deleteTopicFiles(userId: string, topicId: string): Promise<void> {
  const prefix = `${userId}/${topicId}/`;

  try {
    if (!useMinio) {
      const listCommand = new ListObjectsV2Command({
        Bucket: S3_BUCKET_NAME,
        Prefix: prefix,
      });
      const listResponse = await s3Client.send(listCommand);

      if (!listResponse.Contents || listResponse.Contents.length === 0) {
        console.log(`No files found for topic: ${prefix}`);
        return;
      }

      const deleteCommand = new DeleteObjectsCommand({
        Bucket: S3_BUCKET_NAME,
        Delete: {
          Objects: listResponse.Contents.map((obj) => ({ Key: obj.Key! })),
        },
      });
      await s3Client.send(deleteCommand);
      console.log(`Deleted ${listResponse.Contents.length} files for topic: ${prefix}`);
    } else {
      const objectsStream = minioClient!.listObjects(S3_BUCKET_NAME, prefix, true);
      const objectsList: string[] = [];

      for await (const obj of objectsStream) {
        if (obj.name) objectsList.push(obj.name);
      }

      if (objectsList.length === 0) {
        console.log(`No files found for topic: ${prefix}`);
        return;
      }

      await minioClient!.removeObjects(S3_BUCKET_NAME, objectsList);
      console.log(`Deleted ${objectsList.length} files for topic: ${prefix}`);
    }
  } catch (error) {
    console.error(`Error deleting files for topic ${prefix}:`, error);
    throw new S3StorageError(S3ErrorCode.ACCESS_ERROR, `Failed to delete files for topic: ${prefix}`, error as Error);
  }
}
