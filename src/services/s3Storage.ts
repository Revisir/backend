import { PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client, S3_BUCKET_NAME, useSeaweedFS } from "@config/s3.js";
import { ALLOWED_CONTENT_TYPES, MAX_FILE_SIZE } from "@config/fileConstants.js";
import { logger } from "@config/logger.js";
import { buildUploadKey } from "@services/uploadKey.js";

const log = logger.child({ module: "s3Storage" });

/**
 * Rewrites internal SeaweedFS URLs to the public-facing URL for browser access.
 *
 * Presigned URLs are signed against the in-cluster origin, so the reverse proxy
 * fronting S3_PUBLIC_URL must restore that Host upstream or the signature will
 * not verify.
 */
function toPublicUrl(url: string): string {
  if (!useSeaweedFS) return url;
  const publicUrl = process.env.S3_PUBLIC_URL;
  if (!publicUrl) return url;
  const endpoint = process.env.S3_ENDPOINT || "localhost";
  const port = process.env.S3_PORT || "8333";
  const useSSL = process.env.S3_USE_SSL === "true";
  const internalOrigin = `http${useSSL ? "s" : ""}://${endpoint}:${port}`;
  return url.replace(internalOrigin, publicUrl);
}

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
      log.error({ err: error, attempt: attempt + 1, maxRetries: RETRY_CONFIG.maxRetries }, "S3 operation attempt failed");

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

  // Check for invalid characters or patterns. An empty segment ("a//b") means a
  // caller passed an empty userId/topicId/fileName, which would otherwise
  // silently write to a path no lookup can match.
  if (s3Path.includes("..") || s3Path.startsWith("/") || s3Path.includes("//")) {
    throw new S3StorageError(S3ErrorCode.INVALID_PATH, "S3 path contains invalid characters or patterns");
  }
}

/**
 * Generates a presigned URL for uploading files to S3/SeaweedFS.
 * Path format: {userId}/{topicId}/files/{fileName}
 *
 * @param userId - Cognito user ID
 * @param topicId - MongoDB ObjectId of the topic
 * @param fileName - Original file name
 * @param contentType - MIME type of the file
 * @param expiresIn - URL expiration time in seconds (default: 3600)
 * @returns Presigned URL for uploading the file
 */
export async function generatePresignedUploadUrl(userId: string, topicId: string, fileName: string, contentType: string, fileSize: number, expiresIn: number = 3600): Promise<string> {
  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
    throw new S3StorageError(S3ErrorCode.INVALID_PATH, `Content type '${contentType}' is not allowed. Allowed: ${ALLOWED_CONTENT_TYPES.join(", ")}`);
  }

  if (fileSize > MAX_FILE_SIZE) {
    throw new S3StorageError(S3ErrorCode.INVALID_PATH, `File size ${fileSize} exceeds maximum allowed size of ${MAX_FILE_SIZE} bytes`);
  }

  const s3Path = buildUploadKey(userId, topicId, fileName);
  validateS3Path(s3Path);

  try {
    const command = new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: s3Path,
      ContentType: contentType,
      ContentLength: fileSize,
      Metadata: {
        topicid: topicId,
        userid: userId,
        filename: fileName,
      },
    });
    const url = await getSignedUrl(s3Client, command, {
      expiresIn,
      signableHeaders: new Set(["content-length"]),
    });
    log.info({ s3Path }, "Generated presigned upload URL");
    return toPublicUrl(url);
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

  log.info({ s3Path }, "Successfully saved content to S3");
  return s3Path;
}

/**
 * Saves extracted content to S3 at a custom path.
 */
export async function saveExtractedContentAtPath(userId: string, topicId: string, path: string, content: string): Promise<string> {
  const s3Path = `${userId}/${topicId}/extracted/${path}`;
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
        Metadata: { userId, topicId, uploadedAt: new Date().toISOString() },
      });
      await s3Client.send(command);
    },
    S3ErrorCode.UPLOAD_FAILED,
    `Failed to upload content to S3 at path: ${s3Path}`,
  );

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
  if (!s3Path) {
    throw new S3StorageError(S3ErrorCode.INVALID_PATH, "Empty Path not allowed");
  }
  if (!s3Path.startsWith(`${userId}/`)) {
    // Security check: ensure path starts with userId
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

  log.info({ s3Path }, "Successfully retrieved content from S3");
  return content;
}

/**
 * Generates a signed URL for frontend access to S3/SeaweedFS content.
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
    const command = new GetObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: s3Path,
      ResponseContentDisposition: "inline",
    });
    const url = await getSignedUrl(s3Client, command, { expiresIn });
    log.info({ s3Path }, "Generated signed URL for S3 path");
    return toPublicUrl(url);
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
    log.error({ err: error, s3Path }, "Error checking file existence");
    return false;
  }
}

/**
 * Lists and retrieves all extracted content files for a topic.
 * Path format: {userId}/{topicId}/extracted/
 *
 * @param userId - Cognito user ID
 * @param topicId - MongoDB ObjectId of the topic
 * @returns Combined extracted content as a single string
 */
export async function getAllExtractedContent(userId: string, topicId: string): Promise<string> {
  const prefix = `${userId}/${topicId}/extracted/`;

  const listCommand = new ListObjectsV2Command({
    Bucket: S3_BUCKET_NAME,
    Prefix: prefix,
  });
  const listResponse = await s3Client.send(listCommand);

  if (!listResponse.Contents || listResponse.Contents.length === 0) {
    return "";
  }

  const contents: string[] = [];
  for (const obj of listResponse.Contents) {
    if (!obj.Key) continue;
    try {
      const getCommand = new GetObjectCommand({ Bucket: S3_BUCKET_NAME, Key: obj.Key });
      const response = await s3Client.send(getCommand);
      const text = await response.Body!.transformToString();
      const fileName = obj.Key.replace(prefix, "");
      contents.push(`\n### ${fileName}\n${text}`);
    } catch (error) {
      log.error({ err: error, key: obj.Key }, "Failed to retrieve object");
    }
  }

  return contents.join("\n");
}

/**
 * Deletes a file from S3/SeaweedFS by its full path
 */
export async function deleteByPath(s3Path: string): Promise<void> {
  validateS3Path(s3Path);
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET_NAME, Key: s3Path }));
  } catch (error) {
    log.error({ err: error, s3Path }, "Error deleting file by path");
  }
}

/**
 * Deletes a single file from S3/SeaweedFS
 *
 * @param userId - Cognito user ID
 * @param topicId - MongoDB ObjectId of the topic
 * @param fileName - Name of the file to delete
 */
export async function deleteFile(userId: string, topicId: string, fileName: string): Promise<void> {
  const s3Path = `${userId}/${topicId}/files/${fileName}`;
  validateS3Path(s3Path);

  try {
    const deleteCommand = new DeleteObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: s3Path,
    });
    await s3Client.send(deleteCommand);
    log.info({ s3Path }, "Deleted file");
  } catch (error) {
    log.error({ err: error, s3Path }, "Error deleting file");
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
    const listCommand = new ListObjectsV2Command({
      Bucket: S3_BUCKET_NAME,
      Prefix: prefix,
    });
    const listResponse = await s3Client.send(listCommand);

    if (!listResponse.Contents || listResponse.Contents.length === 0) {
      log.info({ prefix }, "No files found for topic");
      return;
    }

    const deleteCommand = new DeleteObjectsCommand({
      Bucket: S3_BUCKET_NAME,
      Delete: {
        Objects: listResponse.Contents.map((obj) => ({ Key: obj.Key! })),
      },
    });
    await s3Client.send(deleteCommand);
    log.info({ prefix, count: listResponse.Contents.length }, "Deleted files for topic");
  } catch (error) {
    log.error({ err: error, prefix }, "Error deleting files for topic");
    throw new S3StorageError(S3ErrorCode.ACCESS_ERROR, `Failed to delete files for topic: ${prefix}`, error as Error);
  }
}
