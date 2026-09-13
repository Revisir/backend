import Firecrawl from "firecrawl";
import { logger } from "@config/logger.js";

const log = logger.child({ module: "firecrawlReader" });

/**
 * Firecrawl Reader Service
 * Scrapes URLs and converts them to LLM-friendly markdown using Firecrawl.
 *
 * Supports both:
 * - Cloud (api.firecrawl.dev) — requires FIRECRAWL_API_KEY
 * - Self-hosted — requires FIRECRAWL_API_URL (API key optional depending on instance config)
 *
 * Docs: https://docs.firecrawl.dev
 * SDK: https://www.npmjs.com/package/firecrawl
 */

export interface FirecrawlReaderResult {
  content: string;
  success: boolean;
  error?: string;
}

/**
 * Create a Firecrawl client configured from environment variables.
 *
 * Env vars:
 *  - FIRECRAWL_API_KEY: API key (required for cloud, optional for self-hosted)
 *  - FIRECRAWL_API_URL: Base URL for self-hosted instance (e.g. http://localhost:3002)
 */
function createClient(): Firecrawl {
  const apiKey = process.env.FIRECRAWL_API_KEY || "";
  const apiUrl = process.env.FIRECRAWL_API_URL; // undefined means use cloud default

  return new Firecrawl({ apiKey, ...(apiUrl && { apiUrl }) });
}

/**
 * Scrape a URL and return its content as markdown using Firecrawl.
 *
 * @param url - The target URL to scrape
 * @returns Markdown content from the page
 */
export async function readUrlWithFirecrawl(url: string): Promise<FirecrawlReaderResult> {
  try {
    const client = createClient();

    const result = await client.scrape(url, {
      formats: ["markdown"],
      onlyMainContent: true,
      timeout: 30000,
    });

    const content = result.markdown || "";

    if (!content || content.trim().length === 0) {
      return {
        content: "",
        success: false,
        error: "Firecrawl returned empty content",
      };
    }

    return { content, success: true };
  } catch (error) {
    const message = formatError(error);
    log.error({ url, error: message }, "Failed to scrape URL");
    return { content: "", success: false, error: message };
  }
}

function formatError(error: unknown): string {
  if (error && typeof error === "object" && "statusCode" in error) {
    const fcErr = error as { statusCode?: number; message?: string };
    const status = fcErr.statusCode;
    if (status === 402) return "Firecrawl quota exceeded or payment required";
    if (status === 429) return "Firecrawl rate limit exceeded";
    if (status === 408) return "Request timed out";
    return `HTTP ${status || "unknown"}: ${fcErr.message || "unknown error"}`;
  }
  if (error instanceof Error) return error.message;
  return "Unknown error";
}
