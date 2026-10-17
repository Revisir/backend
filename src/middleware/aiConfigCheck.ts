import { Request, Response, NextFunction } from "express";
import { ErrorResponse } from "$types/common.types.js";

/**
 * Whether AI/LLM features can run: the local provider needs no key, every other
 * provider needs `LLM_API_KEY`. Shared by `requireAIConfig` and review
 * availability, so the gate and the `ai_not_configured` reason never disagree.
 */
export function isAIConfigured(): boolean {
  const provider = process.env.LLM_PROVIDER || "google";
  return provider === "local" || Boolean(process.env.LLM_API_KEY);
}

/**
 * Middleware to check if AI/LLM is configured (API keys present).
 * Returns a common error response if not, so the frontend can handle it uniformly.
 */
export function requireAIConfig(_req: Request, res: Response, next: NextFunction): void {
  if (!isAIConfigured()) {
    res.status(503).json({
      error: {
        code: "AI_NOT_CONFIGURED",
        message: "AI features are not available. Please configure the AI API keys.",
      },
    } as ErrorResponse);
    return;
  }

  next();
}
