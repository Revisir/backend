export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: any;
  };
}
