import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

// Extend Express Request type to include user information
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
    }
  }
}

// Initialize JWKS client for Cognito public keys
const client = jwksClient({
  jwksUri: `https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}/.well-known/jwks.json`,
  cache: true,
  cacheMaxAge: 600000, // 10 minutes
  rateLimit: true,
  jwksRequestsPerMinute: 10
});

// Function to get the signing key from JWKS
function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      callback(err);
      return;
    }
    const signingKey = key?.getPublicKey();
    callback(null, signingKey);
  });
}

/**
 * Authentication middleware that validates JWT tokens from AWS Cognito
 * Extracts userId and userEmail from the token and attaches them to the request object
 */
export async function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Extract token from Authorization header
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      res.status(401).json({
        error: {
          code: 'NO_TOKEN',
          message: 'Authentication required. Please provide a valid token.'
        }
      });
      return;
    }

    // Verify the JWT token
    jwt.verify(
      token,
      getKey,
      {
        algorithms: ['RS256'],
        issuer: `https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}`
      },
      (err, decoded) => {
        if (err) {
          // Handle different JWT errors
          if (err.name === 'TokenExpiredError') {
            res.status(401).json({
              error: {
                code: 'TOKEN_EXPIRED',
                message: 'Token has expired. Please log in again.'
              }
            });
            return;
          }

          if (err.name === 'JsonWebTokenError') {
            res.status(403).json({
              error: {
                code: 'INVALID_TOKEN',
                message: 'Invalid token. Please log in again.'
              }
            });
            return;
          }

          // Generic error
          res.status(403).json({
            error: {
              code: 'TOKEN_VERIFICATION_FAILED',
              message: 'Token verification failed.'
            }
          });
          return;
        }

        // Extract user information from decoded token
        const payload = decoded as jwt.JwtPayload;
        req.userId = payload.sub; // Cognito user ID (sub claim)
        req.userEmail = payload.email; // User email

        next();
      }
    );
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({
      error: {
        code: 'AUTH_ERROR',
        message: 'An error occurred during authentication.'
      }
    });
  }
}

/**
 * Optional authentication middleware for development/testing
 * Allows requests without authentication when NODE_ENV is 'development'
 * and SKIP_AUTH environment variable is set to 'true'
 */
export function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Skip authentication in development mode if configured
  if (process.env.NODE_ENV === 'development' && process.env.SKIP_AUTH === 'true') {
    // Use a test user ID for development
    req.userId = process.env.TEST_USER_ID || 'test-user-123';
    req.userEmail = 'test@example.com';
    next();
    return;
  }

  // Otherwise, use normal authentication
  authenticateToken(req, res, next);
}
