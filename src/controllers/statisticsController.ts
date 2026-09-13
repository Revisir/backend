import { Request, Response } from "express";
import { Topic } from "@models/Topic.js";
import { RevisionRecord } from "@models/RevisionRecord.js";
import { DuePerSubject, StatisticsResponse } from "$types/statistics.types.js";
import { ErrorResponse } from "$types/common.types.js";
import { DateTime } from "luxon";
import { logger } from "@config/logger.js";

const log = logger.child({ module: "statisticsController" });

/**
 * GET /api/statistics
 * Get dashboard statistics for authenticated user
 */
export async function getStatistics(req: Request, res: Response): Promise<void> {
  try {
    const timeZone = req.headers["X-Local-TimeZone"]?.[0] ?? "Asia/Calcutta";
    const currentDate = DateTime.now().setZone(timeZone).endOf("day");
    const userId = req.userId; // From auth middleware

    // Calculate date ranges
    const currentJs = currentDate.toJSDate();
    const oneWeekAgo = currentDate.minus({ weeks: 1 }).toJSDate();
    const oneMonthAgo = currentDate.minus({ months: 1 }).toJSDate();
    const OneMonthAhead = currentDate.plus({ months: 1 }).toJSDate();

    // Run all queries in parallel for better performance
    const [totalTopics, dueToday, revisedThisWeek, revisedThisMonth, upcomingTopics, perSubject, revisionPerDay] = await Promise.all([
      // Total topics count for user
      Topic.countDocuments({ userId }),

      // Due topics count for user (revisionDate <= currentDate)
      Topic.countDocuments({
        userId,
        revisionDate: { $lte: currentJs },
      }),

      // Topics revised in past week for user
      RevisionRecord.distinct("topicId", {
        userId,
        revisionDate: { $gte: oneWeekAgo, $lte: currentJs },
      }).then((topicIds) => topicIds.length),

      // Topics revised in past month for user
      RevisionRecord.distinct("topicId", {
        userId,
        revisionDate: { $gte: oneMonthAgo, $lte: currentJs },
      }).then((topicIds) => topicIds.length),

      // Upcoming revisions for next 1 month for user
      Topic.find({
        userId,
        revisionDate: { $gt: currentJs, $lte: OneMonthAhead },
      })
        .select("revisionDate")
        .lean(),
      Topic.aggregate([
        {
          $group: {
            _id: {
              subject: "$subjectName",
              due: {
                $cond: {
                  if: { $lte: ["$revisionDate", currentJs] },
                  then: "Due",
                  else: "Revised",
                },
              },
            },
            count: { $sum: 1 },
          },
        },
      ]),
      RevisionRecord.aggregate([
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$revisionDate" } },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    // Aggregate upcoming revisions by date
    const upcomingRevisions = aggregateUpcomingRevisions(upcomingTopics);
    // Build response
    const statsPerSubject = Object.values(
      perSubject.reduce(
        (acc, curr) => {
          const subject = curr._id.subject;
          const status = curr._id.due;
          const count = curr.count;
          if (!acc[subject]) {
            acc[subject] = { name: subject, children: [] };
          }
          let config = { itemStyle: { shadowColor: "#f37324" }, label: { color: "#e12729" } };
          if (status === "Revised") config = { itemStyle: { shadowColor: "#72b043" }, label: { color: "#007f4e" } };
          acc[subject].children.push({ ...config, name: status, value: count });

          return acc;
        },
        {} as Record<string, DuePerSubject>,
      ),
    );
    const revisionPerDayWithMax = prepareCalendarHeatMap(revisionPerDay);
    const statistics: StatisticsResponse = {
      totalTopics,
      dueToday,
      revisedThisWeek,
      revisedThisMonth,
      upcomingRevisions,
      perSubject: statsPerSubject,
      revisionPerDay: revisionPerDayWithMax,
    };

    res.status(200).json(statistics);
  } catch (error) {
    log.error({ err: error }, "Error fetching statistics");

    // Generic error response
    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch statistics",
        details: error instanceof Error ? error.message : "Unknown error",
      },
    } as ErrorResponse);
  }
}

/**
 * Helper function to aggregate upcoming revisions by date
 */
function aggregateUpcomingRevisions(topics: { revisionDate: Date }[]): [string, number][] {
  // Group topics by date (YYYY-MM-DD format)
  const dateMap = new Map<string, number>();

  topics.forEach((topic) => {
    const dateStr = topic.revisionDate.toISOString().split("T")[0];
    dateMap.set(dateStr, (dateMap.get(dateStr) || 0) + 1);
  });

  // Convert to array
  const result = Array.from(dateMap.entries());

  return result;
}

function prepareCalendarHeatMap(arr: { _id: string; count: number }[]): { max: number; dataArr: [string, number][] } {
  if (arr.length === 0) return { max: 0, dataArr: [] };

  let max = 0;
  const arrangedArr = arr.map((ele) => {
    if (ele.count > max) max = ele.count;
    return [ele._id, ele.count] as [string, number];
  });
  return { max, dataArr: arrangedArr };
}
