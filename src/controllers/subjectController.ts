import { Request, Response } from 'express';
import { Topic } from '@models/Topic';
import { ErrorResponse } from '$types/common.types';

/**
 * GET /api/subjects
 * Fetch unique subjects for authenticated user
 */
export async function getSubjects(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = req.userId; // From auth middleware

    // Query distinct subjects for the user
    const subjects = await Topic.distinct('subjectName', { userId });

    // Sort subjects alphabetically
    const sortedSubjects = subjects.sort((a, b) => a.localeCompare(b));

    // Return sorted list of subjects
    res.status(200).json({ subjects: sortedSubjects });
  } catch (error) {
    console.error('Error fetching subjects:', error);

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
