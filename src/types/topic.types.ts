export interface GetTopicsQuery {
  page?: string;
  limit?: string;
  subject?: string;
}

export interface GetTopicsResponse {
  topics: any[];
  total: number;
  page: number;
}
