import * as fc from "fast-check";
import { Request, Response } from "express";
import {
  handleStorageWebhook,
  setWebhookPublisher,
} from "@controllers/storageWebhookController";
import { QueuePublisher } from "@services/rabbitmq/publisher";

/**
 * Feature: rabbitmq-message-queues, Property 6: Webhook message preserves bucket and key
 * Validates: Requirements 4.2
 *
 * For any valid SeaweedFS filer notification naming a bucket and an uploaded
 * object key (`{userId}/{topicId}/files/{fileName}`, not under `/extracted/`),
 * the message published to Queue B SHALL contain the exact same bucket and key
 * values.
 */
describe("Feature: rabbitmq-message-queues, Property 6: Webhook message preserves bucket and key", () => {
  // Generate bucket names: non-empty alphanumeric strings resembling valid S3 bucket names
  const bucketArb = fc.stringMatching(/^[a-z0-9][a-z0-9.-]{1,30}[a-z0-9]$/);

  // Path segments that never introduce a "/" of their own, so the generated key
  // has exactly the structure under test.
  const segmentArb = fc
    .string({ minLength: 1, maxLength: 20 })
    .filter((s) => !s.includes("/") && s.trim().length > 0);

  // Generate upload keys: {userId}/{topicId}/files/{fileName}
  const uploadKeyArb = fc
    .tuple(segmentArb, segmentArb, segmentArb)
    .map(([userId, topicId, fileName]) => `${userId}/${topicId}/files/${fileName}`)
    .filter((key) => !key.includes("/extracted/"));

  function createMockReq(bucket: string, key: string): Partial<Request> {
    return {
      body: {
        // SeaweedFS reports the filer path of the changed entry, and the S3
        // gateway stores every bucket under /buckets/.
        key: `/buckets/${bucket}/${key}`,
        event_type: "create",
        message: {
          new_entry: { name: key.split("/").pop() },
        },
      },
    };
  }

  function createMockRes(): Partial<Response> {
    const res: Partial<Response> = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    return res;
  }

  function mockPublisher(): jest.Mock {
    const publishMock = jest.fn().mockResolvedValue(true);
    setWebhookPublisher({ publish: publishMock } as unknown as QueuePublisher);
    return publishMock;
  }

  it("published message contains the exact same bucket and key from the notification", async () => {
    await fc.assert(
      fc.asyncProperty(bucketArb, uploadKeyArb, async (bucket, key) => {
        const publishMock = mockPublisher();

        const req = createMockReq(bucket, key) as Request;
        const res = createMockRes() as Response;

        await handleStorageWebhook(req, res);

        // The publish should have been called exactly once
        expect(publishMock).toHaveBeenCalledTimes(1);

        // The published message must contain the exact bucket and key
        const publishCall = publishMock.mock.calls[0][0];
        expect(publishCall.message).toEqual({ bucket, key });
      }),
      { numRuns: 100 },
    );
  });

  it("never publishes extracted content, which would reprocess forever", async () => {
    await fc.assert(
      fc.asyncProperty(bucketArb, segmentArb, segmentArb, segmentArb, async (bucket, userId, topicId, name) => {
        const publishMock = mockPublisher();

        const req = createMockReq(bucket, `${userId}/${topicId}/extracted/${name}.md`) as Request;
        await handleStorageWebhook(req, createMockRes() as Response);

        expect(publishMock).not.toHaveBeenCalled();
      }),
      { numRuns: 100 },
    );
  });

  it("never publishes directory events, which the filer emits for every prefix", async () => {
    await fc.assert(
      fc.asyncProperty(bucketArb, uploadKeyArb, async (bucket, key) => {
        const publishMock = mockPublisher();

        const req = createMockReq(bucket, key) as Request;
        req.body.message.new_entry.is_directory = true;
        await handleStorageWebhook(req, createMockRes() as Response);

        expect(publishMock).not.toHaveBeenCalled();
      }),
      { numRuns: 50 },
    );
  });

  it("never publishes keys that are not uploads", async () => {
    // Shapes SeaweedFS really emits, plus near-misses. `.system` writes are the
    // gateway's own bookkeeping; nothing downstream can process any of these.
    const notAnUpload = [
      "/buckets/.system/owners/.complete",
      "/buckets/revision-study-content/user/topic",
      "/buckets/revision-study-content/user/topic/files",
      "/buckets/revision-study-content/user/files",
      "/buckets/revision-study-content/loose.txt",
      "/buckets/revision-study-content",
      "/buckets",
      "/etc/passwd",
    ];

    for (const filerPath of notAnUpload) {
      const publishMock = mockPublisher();

      await handleStorageWebhook(
        { body: { key: filerPath, event_type: "create", message: {} } } as Request,
        createMockRes() as Response,
      );

      expect(publishMock).not.toHaveBeenCalled();
    }
  });

  it("never publishes deletes or renames, which carry no content", async () => {
    await fc.assert(
      fc.asyncProperty(
        bucketArb,
        uploadKeyArb,
        fc.constantFrom("delete", "rename"),
        async (bucket, key, eventType) => {
          const publishMock = mockPublisher();

          const req = createMockReq(bucket, key) as Request;
          req.body.event_type = eventType;
          await handleStorageWebhook(req, createMockRes() as Response);

          expect(publishMock).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 50 },
    );
  });
});
