import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';

/**
 * LLM API Client for Google Gemini
 * Handles text and multimodal prompts with timeout and retry logic
 */

const TIMEOUT_MS = 30000; // 30 seconds
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000; // 1 second

interface LLMClientConfig {
  apiKey: string;
  model?: string;
}

interface MultimodalContent {
  text: string;
  images?: Buffer[];
  mimeTypes?: string[];
}

export class LLMClient {
  private genAI: GoogleGenerativeAI;
  private model: GenerativeModel;

  constructor(config: LLMClientConfig) {
    if (!config.apiKey) {
      throw new Error('Gemini API key is required');
    }

    this.genAI = new GoogleGenerativeAI(config.apiKey);
    // Use gemini-1.5-flash for multimodal support (images, PDFs)
    this.model = this.genAI.getGenerativeModel({ 
      model: config.model || 'gemini-1.5-flash' 
    });
  }

  /**
   * Send a text prompt and receive a response
   * @param prompt - The text prompt to send
   * @returns The LLM response text
   */
  async sendTextPrompt(prompt: string): Promise<string> {
    return this.executeWithRetry(async () => {
      const result = await this.withTimeout(
        this.model.generateContent(prompt),
        TIMEOUT_MS
      );

      const response = result.response;
      const text = response.text();
      
      if (!text) {
        throw new Error('Empty response from LLM');
      }

      return text;
    });
  }

  /**
   * Send a multimodal prompt (text + images/PDFs) and receive a response
   * @param content - Object containing text and optional images
   * @returns The LLM response text
   */
  async sendMultimodalPrompt(content: MultimodalContent): Promise<string> {
    return this.executeWithRetry(async () => {
      const parts: any[] = [{ text: content.text }];

      // Add images if provided
      if (content.images && content.images.length > 0) {
        content.images.forEach((imageBuffer, index) => {
          const mimeType = content.mimeTypes?.[index] || 'image/jpeg';
          parts.push({
            inlineData: {
              data: imageBuffer.toString('base64'),
              mimeType: mimeType
            }
          });
        });
      }

      const result = await this.withTimeout(
        this.model.generateContent(parts),
        TIMEOUT_MS
      );

      const response = result.response;
      const text = response.text();
      
      if (!text) {
        throw new Error('Empty response from LLM');
      }

      return text;
    });
  }

  /**
   * Execute a function with retry logic
   * @param fn - The async function to execute
   * @returns The result of the function
   */
  private async executeWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        
        // Don't retry on certain errors
        if (this.isNonRetryableError(error)) {
          throw error;
        }

        // If this was the last attempt, throw the error
        if (attempt === MAX_RETRIES) {
          break;
        }

        // Wait before retrying (exponential backoff)
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        await this.sleep(delay);
      }
    }

    throw new Error(
      `LLM request failed after ${MAX_RETRIES} attempts: ${lastError?.message}`
    );
  }

  /**
   * Check if an error should not be retried
   * @param error - The error to check
   * @returns True if the error should not be retried
   */
  private isNonRetryableError(error: any): boolean {
    // Don't retry on authentication errors or invalid requests
    const message = error?.message?.toLowerCase() || '';
    return (
      message.includes('api key') ||
      message.includes('invalid') ||
      message.includes('unauthorized') ||
      message.includes('forbidden')
    );
  }

  /**
   * Execute a promise with a timeout
   * @param promise - The promise to execute
   * @param timeoutMs - Timeout in milliseconds
   * @returns The result of the promise
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('LLM request timeout')), timeoutMs)
      )
    ]);
  }

  /**
   * Sleep for a specified duration
   * @param ms - Duration in milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Create a singleton LLM client instance
 */
let llmClientInstance: LLMClient | null = null;

export function getLLMClient(): LLMClient {
  if (!llmClientInstance) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not set');
    }
    llmClientInstance = new LLMClient({ apiKey });
  }
  return llmClientInstance;
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetLLMClient(): void {
  llmClientInstance = null;
}
