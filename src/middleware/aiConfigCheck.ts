import { Request, Response, NextFunction } from "express";
import { ErrorResponse } from "$types/common.types.js";

/**
 * Middleware to check if AI/LLM is configured (API keys present).
 * Returns a common error response if not, so the frontend can handle it uniformly.
 */
export function requireAIConfig(req: Request, res: Response, next: NextFunction): void {
  const provider = process.env.LLM_PROVIDER || "google";
  const apiKey = process.env.LLM_API_KEY;

  if (provider !== "local" && !apiKey) {
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
