import { generateText, LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";

/**
 * LLM Client using Vercel AI SDK
 *
 * Environment variables:
 *   LLM_PROVIDER  - "openai" | "google" | "anthropic" | "local"
 *   LLM_MODEL     - Model name (e.g. "gpt-4o", "gemini-1.5-flash", "claude-3-sonnet-20240229", "llama3")
 *   LLM_API_KEY   - API key (use "ollama" or any string for local)
 *   LLM_BASE_URL  - Required for "local" provider (e.g. http://localhost:11434/v1 for Ollama)
 */

interface MultimodalContent {
  text: string;
  images?: Buffer[];
  mimeTypes?: string[];
}

function createModel(): LanguageModel {
  const provider = process.env.LLM_PROVIDER || "google";
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  const baseURL = process.env.LLM_BASE_URL;

  if (!apiKey && provider !== "local") {
    throw new Error("LLM_API_KEY environment variable is not set");
  }

  switch (provider) {
    case "openai": {
      const openai = createOpenAI({ apiKey, baseURL });
      return openai(model || "gpt-4o-mini");
    }
    case "google": {
      const google = createGoogleGenerativeAI({ apiKey, baseURL });
      return google(model || "gemini-3.1-flash-lite");
    }
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey, baseURL });
      return anthropic(model || "claude-3-sonnet-20240229");
    }
    case "local": {
      if (!baseURL) throw new Error("LLM_BASE_URL is required for local provider (e.g. http://localhost:11434/v1)");
      const local = createOpenAI({ apiKey: apiKey || "local", baseURL });
      return local(model || "llama3");
    }
    default:
      throw new Error(`Unsupported LLM_PROVIDER: ${provider}. Use "openai", "google", "anthropic", or "local".`);
  }
}

export class LLMClient {
  private model: LanguageModel;

  constructor() {
    this.model = createModel();
  }

  async sendTextPrompt(prompt: string, system?: string): Promise<string> {
    const { text } = await generateText({
      model: this.model,
      allowSystemInMessages: false,
      ...(system ? { system, messages: [{ role: "user" as const, content: prompt }] } : { prompt }),
    });
    if (!text) throw new Error("Empty response from LLM");
    return text;
  }

  async sendMultimodalPrompt(content: MultimodalContent): Promise<string> {
    const parts: any[] = [{ type: "text", text: content.text }];

    if (content.images?.length) {
      content.images.forEach((buf, i) => {
        const mimeType = content.mimeTypes?.[i] || "image/jpeg";
        if (mimeType === "application/pdf") {
          parts.push({ type: "file", data: buf, mediaType: mimeType });
        } else {
          parts.push({ type: "image", image: buf, mimeType });
        }
      });
    }

    const { text } = await generateText({
      model: this.model,
      messages: [{ role: "user", content: parts }],
    });
    if (!text) throw new Error("Empty response from LLM");
    return text;
  }
}

let llmClientInstance: LLMClient | null = null;

export function getLLMClient(): LLMClient {
  if (!llmClientInstance) {
    llmClientInstance = new LLMClient();
  }
  return llmClientInstance;
}

export function resetLLMClient(): void {
  llmClientInstance = null;
}
