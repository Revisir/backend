/**
 * The shape of an upload object key, shared by the side that enqueues uploads
 * (`storageWebhookController`) and the side that processes them
 * (`fileProcessor`).
 */
export interface UploadKeyParts {
  userId: string;
  topicId: string;
  fileName: string;
}

/** The object key an upload is stored under, and the `s3Path` of its file entry. */
export function buildUploadKey(userId: string, topicId: string, fileName: string): string {
  return `${userId}/${topicId}/files/${fileName}`;
}

/**
 * Derives the owning user, topic and original file name from an upload key.
 *
 * `generatePresignedUploadUrl` is the only writer of this prefix and always
 * shapes it as `{userId}/{topicId}/files/{fileName}`, so the key carries
 * everything needed. It is read instead of the object's `x-amz-meta-*`
 * metadata because SeaweedFS only stores user metadata arriving as request
 * headers, while the AWS SDK presigner hoists it into the URL query string —
 * so on a presigned browser upload that metadata never lands.
 *
 * Returns null when the key is not an upload: extracted output
 * (`.../extracted/...`), a bare prefix, or one of SeaweedFS's own writes under
 * its `.system` bucket. Nothing downstream can process those.
 */
export function parseUploadKey(key: string): UploadKeyParts | null {
  const [userId, topicId, marker, ...rest] = key.split("/");
  if (marker !== "files") return null;

  const fileName = rest.join("/");
  if (!userId || !topicId || !fileName) return null;

  return { userId, topicId, fileName };
}
