/**
 * Unit tests for SM-2 Algorithm
 * 
 * Tests cover:
 * - E-Factor update formula
 * - Interval calculation logic
 * - Reset logic for quality < 3
 * - E-Factor boundaries enforcement
 * - Edge cases (quality 0, quality 5, boundary E-Factors)
 */

import { calculateNextReview, SM2Input } from './sm2Algorithm';

describe('SM-2 Algorithm', () => {
  describe('E-Factor Update Formula', () => {
    it('should update E-Factor correctly for quality 5 (perfect recall)', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 2,
        interval: 6,
        quality: 5
      };

      const result = calculateNextReview(input);
      
      // EF' = 2.5 + (0.1 - (5-5) * (0.08 + (5-5) * 0.02))
      // EF' = 2.5 + 0.1 = 2.6, but capped at 2.5
      expect(result.eFactor).toBe(2.5);
    });

    it('should update E-Factor correctly for quality 4', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 2,
        interval: 6,
        quality: 4
      };

      const result = calculateNextReview(input);
      
      // EF' = 2.5 + (0.1 - (5-4) * (0.08 + (5-4) * 0.02))
      // EF' = 2.5 + (0.1 - 1 * (0.08 + 1 * 0.02))
      // EF' = 2.5 + (0.1 - 0.1) = 2.5
      expect(result.eFactor).toBe(2.5);
    });

    it('should update E-Factor correctly for quality 3', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 2,
        interval: 6,
        quality: 3
      };

      const result = calculateNextReview(input);
      
      // EF' = 2.5 + (0.1 - (5-3) * (0.08 + (5-3) * 0.02))
      // EF' = 2.5 + (0.1 - 2 * (0.08 + 2 * 0.02))
      // EF' = 2.5 + (0.1 - 2 * 0.12)
      // EF' = 2.5 + (0.1 - 0.24) = 2.36
      expect(result.eFactor).toBeCloseTo(2.36, 2);
    });

    it('should update E-Factor correctly for quality 2', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 2,
        interval: 6,
        quality: 2
      };

      const result = calculateNextReview(input);
      
      // EF' = 2.5 + (0.1 - (5-2) * (0.08 + (5-2) * 0.02))
      // EF' = 2.5 + (0.1 - 3 * (0.08 + 3 * 0.02))
      // EF' = 2.5 + (0.1 - 3 * 0.14)
      // EF' = 2.5 + (0.1 - 0.42) = 2.18
      expect(result.eFactor).toBeCloseTo(2.18, 2);
    });
  });

  describe('E-Factor Boundaries', () => {
    it('should enforce minimum E-Factor of 1.3', () => {
      const input: SM2Input = {
        eFactor: 1.3,
        repetitionNumber: 2,
        interval: 6,
        quality: 0 // Complete blackout
      };

      const result = calculateNextReview(input);
      
      // EF' = 1.3 + (0.1 - (5-0) * (0.08 + (5-0) * 0.02))
      // EF' = 1.3 + (0.1 - 5 * (0.08 + 5 * 0.02))
      // EF' = 1.3 + (0.1 - 5 * 0.18)
      // EF' = 1.3 + (0.1 - 0.9) = 0.5, but should be capped at 1.3
      expect(result.eFactor).toBe(1.3);
    });

    it('should enforce maximum E-Factor of 2.5', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 2,
        interval: 6,
        quality: 5
      };

      const result = calculateNextReview(input);
      
      // EF' would be 2.6, but should be capped at 2.5
      expect(result.eFactor).toBe(2.5);
    });

    it('should keep E-Factor within bounds for quality 1', () => {
      const input: SM2Input = {
        eFactor: 1.5,
        repetitionNumber: 2,
        interval: 6,
        quality: 1
      };

      const result = calculateNextReview(input);
      
      // Should result in a low E-Factor but still >= 1.3
      expect(result.eFactor).toBeGreaterThanOrEqual(1.3);
      expect(result.eFactor).toBeLessThanOrEqual(2.5);
    });
  });

  describe('Interval Calculation Logic', () => {
    it('should set interval to 1 day for first repetition', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 0,
        interval: 1,
        quality: 4
      };

      const result = calculateNextReview(input);
      
      expect(result.repetitionNumber).toBe(1);
      expect(result.interval).toBe(1);
    });

    it('should set interval to 6 days for second repetition', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 1,
        interval: 1,
        quality: 4
      };

      const result = calculateNextReview(input);
      
      expect(result.repetitionNumber).toBe(2);
      expect(result.interval).toBe(6);
    });

    it('should calculate interval as I(n-1) * EF for n > 2', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 2,
        interval: 6,
        quality: 4
      };

      const result = calculateNextReview(input);
      
      expect(result.repetitionNumber).toBe(3);
      // I(3) = I(2) * EF = 6 * 2.5 = 15
      expect(result.interval).toBe(15);
    });

    it('should round interval to nearest integer', () => {
      const input: SM2Input = {
        eFactor: 2.36,
        repetitionNumber: 2,
        interval: 6,
        quality: 3
      };

      const result = calculateNextReview(input);
      
      // First, E-Factor updates: EF' = 2.36 + (0.1 - 2 * 0.12) = 2.36 - 0.14 = 2.22
      // Then I(3) = 6 * 2.22 = 13.32, should round to 13
      expect(result.interval).toBe(13);
    });

    it('should calculate progressively longer intervals', () => {
      let state: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 0,
        interval: 1,
        quality: 4
      };

      // First review
      let result = calculateNextReview(state);
      expect(result.interval).toBe(1);

      // Second review
      state = { ...result, quality: 4 };
      result = calculateNextReview(state);
      expect(result.interval).toBe(6);

      // Third review
      state = { ...result, quality: 4 };
      result = calculateNextReview(state);
      expect(result.interval).toBe(15);

      // Fourth review
      state = { ...result, quality: 4 };
      result = calculateNextReview(state);
      expect(result.interval).toBe(38); // 15 * 2.5 = 37.5, rounds to 38
    });
  });

  describe('Reset Logic for Quality < 3', () => {
    it('should reset repetition to 0 for quality 2', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 5,
        interval: 50,
        quality: 2
      };

      const result = calculateNextReview(input);
      
      expect(result.repetitionNumber).toBe(0);
      expect(result.interval).toBe(1);
    });

    it('should reset repetition to 0 for quality 1', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 3,
        interval: 15,
        quality: 1
      };

      const result = calculateNextReview(input);
      
      expect(result.repetitionNumber).toBe(0);
      expect(result.interval).toBe(1);
    });

    it('should reset repetition to 0 for quality 0', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 10,
        interval: 200,
        quality: 0
      };

      const result = calculateNextReview(input);
      
      expect(result.repetitionNumber).toBe(0);
      expect(result.interval).toBe(1);
    });

    it('should NOT reset for quality 3 (boundary case)', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 2,
        interval: 6,
        quality: 3
      };

      const result = calculateNextReview(input);
      
      // Quality 3 is passing, should progress
      expect(result.repetitionNumber).toBe(3);
      expect(result.interval).toBeGreaterThan(1);
    });

    it('should update E-Factor even when resetting', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 5,
        interval: 50,
        quality: 2
      };

      const result = calculateNextReview(input);
      
      // Repetition resets but E-Factor still updates
      expect(result.repetitionNumber).toBe(0);
      expect(result.interval).toBe(1);
      expect(result.eFactor).not.toBe(2.5); // E-Factor should change
      expect(result.eFactor).toBeCloseTo(2.18, 2);
    });
  });

  describe('Next Revision Date Calculation', () => {
    it('should calculate next revision date correctly', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 2,
        interval: 6,
        quality: 4
      };

      const result = calculateNextReview(input);

      // Next revision should be 15 days from now
      const expectedDate = new Date();
      expectedDate.setDate(expectedDate.getDate() + 15);

      // Allow for small time differences during test execution
      const timeDiff = Math.abs(result.nextRevisionDate.getTime() - expectedDate.getTime());
      expect(timeDiff).toBeLessThan(1000); // Within 1 second
    });

    it('should return a Date object for nextRevisionDate', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 0,
        interval: 1,
        quality: 4
      };

      const result = calculateNextReview(input);
      
      expect(result.nextRevisionDate).toBeInstanceOf(Date);
    });
  });

  describe('Edge Cases', () => {
    it('should handle quality 0 (complete blackout)', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 5,
        interval: 50,
        quality: 0
      };

      const result = calculateNextReview(input);
      
      expect(result.repetitionNumber).toBe(0);
      expect(result.interval).toBe(1);
      // EF' = 2.5 + (0.1 - 5 * 0.18) = 2.5 - 0.8 = 1.7
      expect(result.eFactor).toBeCloseTo(1.7, 2);
    });

    it('should handle quality 5 (perfect recall)', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 2,
        interval: 6,
        quality: 5
      };

      const result = calculateNextReview(input);
      
      expect(result.repetitionNumber).toBe(3);
      expect(result.interval).toBe(15);
      expect(result.eFactor).toBe(2.5); // Should stay at maximum
    });

    it('should handle E-Factor at minimum boundary (1.3)', () => {
      const input: SM2Input = {
        eFactor: 1.3,
        repetitionNumber: 2,
        interval: 6,
        quality: 4
      };

      const result = calculateNextReview(input);
      
      expect(result.eFactor).toBe(1.3); // Should stay at 1.3
      expect(result.repetitionNumber).toBe(3);
      expect(result.interval).toBe(8); // 6 * 1.3 = 7.8, rounds to 8
    });

    it('should handle E-Factor at maximum boundary (2.5)', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 2,
        interval: 6,
        quality: 4
      };

      const result = calculateNextReview(input);
      
      expect(result.eFactor).toBe(2.5);
      expect(result.repetitionNumber).toBe(3);
      expect(result.interval).toBe(15);
    });

    it('should handle first repetition (n=0)', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 0,
        interval: 1,
        quality: 4
      };

      const result = calculateNextReview(input);
      
      expect(result.repetitionNumber).toBe(1);
      expect(result.interval).toBe(1);
    });

    it('should handle second repetition (n=1)', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 1,
        interval: 1,
        quality: 4
      };

      const result = calculateNextReview(input);
      
      expect(result.repetitionNumber).toBe(2);
      expect(result.interval).toBe(6);
    });

    it('should handle very high repetition numbers', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 100,
        interval: 10000,
        quality: 4
      };

      const result = calculateNextReview(input);
      
      expect(result.repetitionNumber).toBe(101);
      expect(result.interval).toBe(25000); // 10000 * 2.5
    });
  });

  describe('Return Value Structure', () => {
    it('should return all required fields', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 2,
        interval: 6,
        quality: 4
      };

      const result = calculateNextReview(input);
      
      expect(result).toHaveProperty('eFactor');
      expect(result).toHaveProperty('repetitionNumber');
      expect(result).toHaveProperty('interval');
      expect(result).toHaveProperty('nextRevisionDate');
    });

    it('should return correct types for all fields', () => {
      const input: SM2Input = {
        eFactor: 2.5,
        repetitionNumber: 2,
        interval: 6,
        quality: 4
      };

      const result = calculateNextReview(input);
      
      expect(typeof result.eFactor).toBe('number');
      expect(typeof result.repetitionNumber).toBe('number');
      expect(typeof result.interval).toBe('number');
      expect(result.nextRevisionDate).toBeInstanceOf(Date);
    });
  });
});
