import { Request, Response, NextFunction } from "express";
import * as jose from "jose";
import { logger } from "@config/logger.js";

const log = logger.child({ module: "auth" });

// Extend Express Request type to include user information
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
    }
  }
}
if (!process.env.AUTH_AUTHORITY) {
  throw new Error("Need AUTH_AUTHORITY");
}
const client = jose.createRemoteJWKSet(new URL(`${process.env.AUTH_AUTHORITY}/.well-known/jwks.json`));

/**
 * Authentication middleware that validates JWT tokens from AWS Cognito
 * Extracts userId and userEmail from the token and attaches them to the request object
 */
export async function authenticateToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Extract token from Authorization header
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.replace("Bearer", "").trim(); // Bearer TOKEN

    if (!token) {
      res.status(401).json({
        error: {
          code: "NO_TOKEN",
          message: "Authentication required. Please provide a valid token.",
        },
      });
      return;
    }
    // Verify the JWT token
    jose
      .jwtVerify(token, client)
      .then(({ payload }) => {
        log.debug({ sub: payload.sub }, "JWT verified");
        req.userId = payload.sub; // Cognito user ID (sub claim)
        if (payload.email) {
          req.userEmail = payload.email as string; // User email
        } else {
          throw new Error("Email is required in Auth Scope");
        }
        next();
      })
      .catch((err) => {
        // Handle different JWT errors
        if (err.name === "JWTExpired") {
          res.status(401).json({
            error: {
              code: "TOKEN_EXPIRED",
              message: "Token has expired. Please log in again.",
            },
          });
          return;
        }

        if (err.name === "JWSInvalid") {
          res.status(403).json({
            error: {
              code: "INVALID_TOKEN",
              message: "Invalid token. Please log in again.",
            },
          });
          return;
        }

        // Generic error
        res.status(403).json({
          error: {
            code: "TOKEN_VERIFICATION_FAILED",
            message: "Token verification failed.",
          },
        });
        return;
      });
  } catch (error) {
    log.error({ err: error }, "Authentication error");
    res.status(500).json({
      error: {
        code: "AUTH_ERROR",
        message: "An error occurred during authentication.",
      },
    });
  }
}

/**
 * Optional authentication middleware for development/testing
 * Allows requests without authentication when NODE_ENV is 'development'
 * and SKIP_AUTH environment variable is set to 'true'
 */
export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  // Skip authentication in development mode if configured
  if (process.env.NODE_ENV === "development" && process.env.SKIP_AUTH === "true") {
    // Use a test user ID for development
    req.userId = process.env.TEST_USER_ID || "test-user-123";
    req.userEmail = "test@example.com";
    next();
    return;
  }

  // Otherwise, use normal authentication
  authenticateToken(req, res, next);
}
