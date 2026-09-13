import { z } from "zod";

/**
 * A SeaweedFS filer notification, as POSTed by `[notification.webhook]`.
 *
 * `key` is the filer path of the changed entry (`/buckets/{bucket}/{objectKey}`
 * for anything written through the S3 gateway), and `message` is the filer's
 * `EventNotification` serialised with Go's `encoding/json` — hence the
 * snake_case field names rather than protobuf JSON's camelCase.
 */
export const storageNotificationSchema = z.object({
  key: z.string().min(1),
  event_type: z.string().min(1),
  message: z
    .object({
      new_entry: z
        .object({
          name: z.string().optional(),
          is_directory: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type StorageNotification = z.infer<typeof storageNotificationSchema>;
