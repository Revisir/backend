import * as fc from "fast-check";
import { computeBackoffDelay } from "@services/rabbitmq/connectionManager";

/**
 * Feature: rabbitmq-message-queues, Property 1: Exponential backoff delay computation
 * Validates: Requirements 1.2
 *
 * For any positive integer attempt (1+), positive initialDelay, and positive maxDelay (>= initialDelay):
 * - The delay equals min(initialDelay * 2^(attempt-1), maxDelay)
 * - The delay is always >= initialDelay (for attempt >= 1)
 * - The delay is always <= maxDelay
 * - The delay is monotonically non-decreasing as attempt increases (for fixed initial/max)
 */
describe("Feature: rabbitmq-message-queues, Property 1: Exponential backoff delay computation", () => {
  // Constrain attempts to a reasonable range to avoid floating-point overflow
  const attemptArb = fc.integer({ min: 1, max: 30 });
  const initialDelayArb = fc.integer({ min: 1, max: 60000 });
  const maxDelayArb = fc.integer({ min: 1, max: 300000 });

  // Arbitrary that ensures maxDelay >= initialDelay
  const configArb = fc
    .tuple(initialDelayArb, maxDelayArb)
    .map(([initial, max]) => ({
      initialDelay: Math.min(initial, max),
      maxDelay: Math.max(initial, max),
    }));

  it("computed delay equals min(initialDelay * 2^(attempt-1), maxDelay)", () => {
    fc.assert(
      fc.property(attemptArb, configArb, (attempt, { initialDelay, maxDelay }) => {
        const result = computeBackoffDelay(attempt, initialDelay, maxDelay);
        const expected = Math.min(initialDelay * Math.pow(2, attempt - 1), maxDelay);
        expect(result).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });

  it("delay is always >= initialDelay for attempt >= 1", () => {
    fc.assert(
      fc.property(attemptArb, configArb, (attempt, { initialDelay, maxDelay }) => {
        const result = computeBackoffDelay(attempt, initialDelay, maxDelay);
        expect(result).toBeGreaterThanOrEqual(initialDelay);
      }),
      { numRuns: 200 },
    );
  });

  it("delay is always <= maxDelay", () => {
    fc.assert(
      fc.property(attemptArb, configArb, (attempt, { initialDelay, maxDelay }) => {
        const result = computeBackoffDelay(attempt, initialDelay, maxDelay);
        expect(result).toBeLessThanOrEqual(maxDelay);
      }),
      { numRuns: 200 },
    );
  });

  it("delay is monotonically non-decreasing as attempt increases", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 29 }),
        configArb,
        (attempt, { initialDelay, maxDelay }) => {
          const delay1 = computeBackoffDelay(attempt, initialDelay, maxDelay);
          const delay2 = computeBackoffDelay(attempt + 1, initialDelay, maxDelay);
          expect(delay2).toBeGreaterThanOrEqual(delay1);
        },
      ),
      { numRuns: 200 },
    );
  });
});
