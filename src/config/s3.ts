import { S3Client } from "@aws-sdk/client-s3";

/**
 * True when object storage is the self-hosted SeaweedFS S3 gateway rather than
 * AWS S3. `BUCKET_TYPE`, not `NODE_ENV`, is the switch.
 */
export const useSeaweedFS = process.env.BUCKET_TYPE === "seaweedfs";

/**
 * Creates an S3 client configured for either AWS S3 or the SeaweedFS S3 gateway.
 *
 * `BUCKET_TYPE=seaweedfs`:
 * - Endpoint from S3_ENDPOINT:S3_PORT (defaults to localhost:8333)
 * - Credentials from S3_ACCESS_KEY and S3_SECRET_KEY, which must match an
 *   identity in the gateway's `s3.json`
 * - Path-style addressing, and TLS via S3_USE_SSL
 *
 * Anything else:
 * - AWS S3 with credentials from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
 * - Region from AWS_REGION (defaults to us-east-1)
 *
 * @returns Configured S3Client instance
 */
export const createS3Client = (): S3Client => {
  if (!useSeaweedFS) {
    // AWS S3
    return new S3Client({
      region: process.env.AWS_REGION || "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      },
    });
  }

  // SeaweedFS S3 gateway
  const endpoint = process.env.S3_ENDPOINT || "localhost";
  const port = process.env.S3_PORT || "8333";
  const useSSL = process.env.S3_USE_SSL === "true";

  return new S3Client({
    region: process.env.AWS_REGION || "us-east-1", // SeaweedFS requires a region but does not use it
    endpoint: `http${useSSL ? "s" : ""}://${endpoint}:${port}`,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY || "seaweedfsadmin",
      secretAccessKey: process.env.S3_SECRET_KEY || "seaweedfsadmin",
    },
    forcePathStyle: true,
    // SeaweedFS reads x-amz-checksum-* out of the presigned query string and
    // verifies it against the bytes the browser actually uploads. The SDK
    // default ("WHEN_SUPPORTED") hoists a CRC32 of the *empty* presign body
    // into that query, so every presigned upload would fail the check.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
};

/**
 * Singleton S3 client instance.
 * Automatically configured based on BUCKET_TYPE.
 */
export const s3Client = createS3Client();

/**
 * S3 bucket name for storing extracted content.
 * Defaults to 'revision-study-content' if not specified.
 */
export const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || "revision-study-content";
