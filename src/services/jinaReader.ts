import axios from "axios";
import { logger } from "@config/logger.js";

const log = logger.child({ module: "jinaReader" });

/**
 * Jina Reader Service
 * Converts any URL to LLM-friendly markdown using https://r.jina.ai
 *
 * Jina Reader doesn't provide an npm SDK — it's an API-first service
 * accessed by prepending https://r.jina.ai/ to any target URL.
 *
 * Docs: https://github.com/jina-ai/reader
 * API playground: https://jina.ai/reader
 */

const JINA_READER_BASE = "https://r.jina.ai";

export type JinaEngine = "browser" | "curl" | "auto";
export type JinaRespondWith = "markdown" | "html" | "text" | "screenshot" | "pageshot" | "frontmatter";

export interface JinaReaderOptions {
  /** API key for higher rate limits. Falls back to JINA_API_KEY env var. */
  apiKey?: string;
  /** Fetching engine: 'browser' (headless Chrome), 'curl' (lightweight), or 'auto' (default). */
  engine?: JinaEngine;
  /** Output format. Defaults to 'markdown'. */
  respondWith?: JinaRespondWith;
  /** CSS selector to extract content from a specific element. */
  targetSelector?: string;
  /** CSS selector to wait for before extracting content. */
  waitForSelector?: string;
  /** Timeout in seconds (max 180). Reader waits for network idle or until timeout. */
  timeout?: number;
  /** Max tokens to return. Response is truncated (not rejected) if exceeded. */
  maxTokens?: number;
  /** Bypass cached pages. */
  noCache?: boolean;
  /** Generate alt text for images using a vision-language model. */
  withGeneratedAlt?: boolean;
  /** Control how images appear: 'all' | 'none' | 'alt'. */
  retainImages?: "all" | "none" | "alt";
  /** Control how links appear: 'all' | 'none' | 'text'. */
  retainLinks?: "all" | "none" | "text";
  /** Request JSON response format. */
  jsonMode?: boolean;
}

export interface JinaReaderResult {
  content: string;
  success: boolean;
  error?: string;
}

export interface JinaReaderJsonResult {
  url: string;
  title: string;
  content: string;
  publishedTime?: string;
}

/**
 * Build request headers from options
 */
function buildHeaders(options: JinaReaderOptions): Record<string, string> {
  const headers: Record<string, string> = {};

  const apiKey = options.apiKey || process.env.JINA_API_KEY;
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  } else {
    log.warn("Missing Jina API key");
  }

  if (options.engine) {
    headers["X-Engine"] = options.engine;
  }

  if (options.respondWith) {
    headers["X-Respond-With"] = options.respondWith;
  }

  if (options.targetSelector) {
    headers["X-Target-Selector"] = options.targetSelector;
  }

  if (options.waitForSelector) {
    headers["X-Wait-For-Selector"] = options.waitForSelector;
  }

  if (options.timeout) {
    headers["X-Timeout"] = String(Math.min(options.timeout, 180));
  }

  if (options.maxTokens) {
    headers["X-Max-Tokens"] = String(options.maxTokens);
  }

  if (options.noCache) {
    headers["X-No-Cache"] = "true";
  }

  if (options.withGeneratedAlt) {
    headers["X-With-Generated-Alt"] = "true";
  }

  if (options.retainImages) {
    headers["X-Retain-Images"] = options.retainImages;
  }

  if (options.retainLinks) {
    headers["X-Retain-Links"] = options.retainLinks;
  }

  if (options.jsonMode) {
    headers["Accept"] = "application/json";
  }

  return headers;
}

/**
 * Fetch a URL and convert it to LLM-friendly markdown using Jina Reader.
 *
 * @param url - The target URL to read
 * @param options - Configuration options for the request
 * @returns The extracted content as markdown
 */
export async function readUrl(url: string, options: JinaReaderOptions = {}): Promise<JinaReaderResult> {
  try {
    const headers = buildHeaders(options);
    const readerUrl = `${JINA_READER_BASE}/${url}`;

    const response = await axios.get(readerUrl, {
      headers,
      timeout: ((options.timeout || 30) + 10) * 1000, // axios timeout slightly higher than Jina's
    });

    const content = typeof response.data === "string" ? response.data : JSON.stringify(response.data);

    if (!content || content.trim().length === 0) {
      return {
        content: "",
        success: false,
        error: "Jina Reader returned empty content",
      };
    }

    return { content, success: true };
  } catch (error) {
    const message = formatError(error);
    log.error({ url, error: message }, "Failed to read URL");
    return { content: "", success: false, error: message };
  }
}

/**
 * Fetch a URL and return structured JSON (title, content, url, timestamp).
 *
 * @param url - The target URL to read
 * @param options - Configuration options for the request
 * @returns Structured JSON result from Jina Reader
 */
export async function readUrlAsJson(url: string, options: JinaReaderOptions = {}): Promise<JinaReaderJsonResult | null> {
  const result = await readUrl(url, { ...options, jsonMode: true });

  if (!result.success) return null;

  try {
    const parsed = JSON.parse(result.content);
    return {
      url: parsed.url || url,
      title: parsed.title || "",
      content: parsed.content || "",
      publishedTime: parsed.publishedTime,
    };
  } catch {
    // If JSON parse fails, the response was likely plain text
    return { url, title: "", content: result.content };
  }
}

/**
 * Fetch a URL optimized for educational/study content extraction.
 * Uses browser engine and strips unnecessary images/links for cleaner LLM input.
 *
 * @param url - The target URL to read
 * @returns Clean markdown content suitable for study material processing
 */
export async function readUrlForStudy(url: string): Promise<JinaReaderResult> {
  return readUrl(url, {
    engine: "browser",
    respondWith: "markdown",
    retainImages: "none",
    retainLinks: "text",
    timeout: 30,
  });
}

function formatError(error: unknown): string {
  if (error && typeof error === "object" && "response" in error) {
    const axiosErr = error as { response?: { status?: number; data?: unknown }; code?: string; message?: string };
    const status = axiosErr.response?.status;
    const data = axiosErr.response?.data;
    if (status === 402) return "Jina API quota exceeded or payment required";
    if (status === 429) return "Jina API rate limit exceeded";
    if (status === 408 || axiosErr.code === "ECONNABORTED") return "Request timed out";
    return `HTTP ${status || "unknown"}: ${typeof data === "string" ? data.slice(0, 200) : axiosErr.message || "unknown error"}`;
  }
  if (error instanceof Error) return error.message;
  return "Unknown error";
}
