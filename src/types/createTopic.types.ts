export interface CreateTopicBody {
  topicName: string;
  subjectName: string;
  description?: string;
  dateStudied: string;
  files?: Array<{
    fileName: string;
    size: number;
    contentType: string;
  }>;
}

export interface CreateTopicResponse {
  topicId: string;
  revisionDate: string;
  uploadUrls?: Array<{
    fileName: string;
    uploadUrl: string;
  }>;
}
