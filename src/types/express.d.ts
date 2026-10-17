/**
 * Request fields set by the auth middleware (`authenticateToken` / `optionalAuth`).
 *
 * Lives in a standalone declaration file rather than in `src/middleware/auth.ts`
 * so that every program — including the test program in `tsconfig.test.json`,
 * which only includes test files — sees the augmentation without having to
 * import the auth middleware (which throws at import without AUTH_AUTHORITY).
 */
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
    }
  }
}

export {};
