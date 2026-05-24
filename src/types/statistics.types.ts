export interface StatisticsResponse {
  totalTopics: number;
  dueToday: number;
  revisedThisWeek: number;
  revisedThisMonth: number;
  upcomingRevisions: [string, number][];
  perSubject: object;
  revisionPerDay: { max: number; dataArr: [string, number][] };
}

export interface DuePerSubject {
  name: string;
  children: { name: string; value: number }[];
}
