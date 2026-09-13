import { Request, Response } from 'express';
import { Topic } from '@models/Topic.js';
import { ErrorResponse } from '$types/common.types.js';
import { logger } from "@config/logger.js";

const log = logger.child({ module: "subjectController" });

/**
 * GET /api/subjects?q=geo
 * Fetch unique subjects for authenticated user, optionally filtered by prefix
 */
export async function getSubjects(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = req.userId; // From auth middleware
    const q = req.query.q as string | undefined;

    const filter: Record<string, unknown> = { userId };
    if (q) {
      filter.subjectName = { $regex: `^${q}`, $options: 'i' };
    }

    const subjects = await Topic.distinct('subjectName', filter);
    const sortedSubjects = subjects.sort((a, b) => a.localeCompare(b));

    // Return sorted list of subjects
    res.status(200).json({ subjects: sortedSubjects });
  } catch (error) {
    log.error({ err: error }, "Error fetching subjects");

    // Generic error response
    res.status(500).json({
      error: {
        code: 'FETCH_SUBJECTS_FAILED',
        message: 'Failed to fetch subjects',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
    } as ErrorResponse);
  }
}
