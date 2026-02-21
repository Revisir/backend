import { Request, Response } from 'express';
import { Topic } from '@models/Topic';
import { RevisionRecord } from '@models/RevisionRecord';
import { StatisticsResponse } from '$types/statistics.types';
import { ErrorResponse } from '$types/common.types';

/**
 * GET /api/statistics
 * Get dashboard statistics for authenticated user
 */
export async function getStatistics(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const currentDate = new Date();
    const userId = req.userId; // From auth middleware
    
    // Calculate date ranges
    const oneWeekAgo = new Date(currentDate.getTime() - 7 * 24 * 60 * 60 * 1000);
    const oneMonthAgo = new Date(currentDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysFromNow = new Date(currentDate.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Run all queries in parallel for better performance
    const [
      totalTopics,
      dueToday,
      revisedThisWeek,
      revisedThisMonth,
      upcomingTopics,
    ] = await Promise.all([
      // Total topics count for user
      Topic.countDocuments({ userId }),

      // Due topics count for user (revisionDate <= currentDate)
      Topic.countDocuments({
        userId,
        revisionDate: { $lte: currentDate },
      }),

      // Topics revised in past week for user
      RevisionRecord.distinct('topicId', {
        userId,
        revisionDate: { $gte: oneWeekAgo, $lte: currentDate },
      }).then((topicIds) => topicIds.length),

      // Topics revised in past month for user
      RevisionRecord.distinct('topicId', {
        userId,
        revisionDate: { $gte: oneMonthAgo, $lte: currentDate },
      }).then((topicIds) => topicIds.length),

      // Upcoming revisions for next 7 days for user
      Topic.find({
        userId,
        revisionDate: { $gt: currentDate, $lte: sevenDaysFromNow },
      })
        .select('revisionDate')
        .lean(),
    ]);

    // Aggregate upcoming revisions by date
    const upcomingRevisions = aggregateUpcomingRevisions(upcomingTopics);

    // Build response
    const statistics: StatisticsResponse = {
      totalTopics,
      dueToday,
      revisedThisWeek,
      revisedThisMonth,
      upcomingRevisions,
    };

    res.status(200).json(statistics);
  } catch (error) {
    console.error('Error fetching statistics:', error);

    // Generic error response
    res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch statistics',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
    } as ErrorResponse);
  }
}

/**
 * Helper function to aggregate upcoming revisions by date
 */
function aggregateUpcomingRevisions(
  topics: { revisionDate: Date }[]
): { date: string; count: number }[] {
  // Group topics by date (YYYY-MM-DD format)
  const dateMap = new Map<string, number>();

  topics.forEach((topic) => {
    const dateStr = topic.revisionDate.toISOString().split('T')[0];
    dateMap.set(dateStr, (dateMap.get(dateStr) || 0) + 1);
  });

  // Convert to array and sort by date
  const result = Array.from(dateMap.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return result;
}
