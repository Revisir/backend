import * as fc from "fast-check";
import {
  urlProcessingMessageSchema,
  fileProcessingMessageSchema,
} from "../../../schemas/queue.schema";

/**
 * Feature: rabbitmq-message-queues, Property 9: Message serialization round trip
 * Validates: Requirements 7.1, 7.2
 *
 * For any valid UrlProcessingMessage or FileProcessingMessage, serializing to JSON
 * and deserializing back SHALL produce an object equal to the original.
 */
describe("Feature: rabbitmq-message-queues, Property 9: Message serialization round trip", () => {
  // Generator for valid UrlProcessingMessage objects
  const urlMessageArb = fc.record({
    topicId: fc.string({ minLength: 1, maxLength: 50 }),
    userId: fc.string({ minLength: 1, maxLength: 50 }),
    urls: fc.array(
      fc.webUrl({ withFragments: false }).filter((u) => u.startsWith("http")),
      { minLength: 1, maxLength: 10 },
    ),
  });

  // Generator for valid FileProcessingMessage objects
  const fileMessageArb = fc.record({
    bucket: fc.string({ minLength: 1, maxLength: 50 }),
    key: fc.string({ minLength: 1, maxLength: 100 }),
  });

  describe("UrlProcessingMessage round trip", () => {
    it("serializing to JSON and deserializing back produces an equal object", () => {
      fc.assert(
        fc.property(urlMessageArb, (message) => {
          // Serialize
          const serialized = JSON.stringify(message);

          // Deserialize
          const deserialized = JSON.parse(serialized);

          // Round-tripped object equals original
          expect(deserialized).toEqual(message);

          // Validate against schema to confirm it's still valid
          const result = urlProcessingMessageSchema.safeParse(deserialized);
          expect(result.success).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("FileProcessingMessage round trip", () => {
    it("serializing to JSON and deserializing back produces an equal object", () => {
      fc.assert(
        fc.property(fileMessageArb, (message) => {
          // Serialize
          const serialized = JSON.stringify(message);

          // Deserialize
          const deserialized = JSON.parse(serialized);

          // Round-tripped object equals original
          expect(deserialized).toEqual(message);

          // Validate against schema to confirm it's still valid
          const result = fileProcessingMessageSchema.safeParse(deserialized);
          expect(result.success).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });
});
