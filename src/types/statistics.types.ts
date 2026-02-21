export interface StatisticsResponse {
  totalTopics: number;
  dueToday: number;
  revisedThisWeek: number;
  revisedThisMonth: number;
  upcomingRevisions: { date: string; count: number }[];
}
