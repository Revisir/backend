import express, { type Express, type Router } from "express";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const MONGO_HOOK_TIMEOUT_MS = 120_000;

/**
 * Starts one in-memory MongoDB for the calling suite and wipes every collection
 * between tests. Call at the top level of a test file.
 */
export function useMongoMemoryServer(): void {
  let server: MongoMemoryServer | undefined;

  // Starting mongod can take well over Jest's 5s hook default when several
  // suites start one at once.
  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
  }, MONGO_HOOK_TIMEOUT_MS);

  afterEach(async () => {
    const db = mongoose.connection.db;
    if (!db) return;
    const collections = await db.collections();
    await Promise.all(collections.map((c) => c.deleteMany({})));
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  }, MONGO_HOOK_TIMEOUT_MS);
}

/** Header the tests use to act as a specific user. */
export const TEST_USER_HEADER = "x-test-user";

/**
 * An Express app with the given routers mounted, and a stand-in for the auth
 * middleware: `req.userId` comes from the `x-test-user` header, defaulting to
 * `"user-1"`.
 */
export function buildTestApp(mounts: Record<string, Router>): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = req.header(TEST_USER_HEADER) ?? "user-1";
    next();
  });
  for (const [path, router] of Object.entries(mounts)) app.use(path, router);
  return app;
}

/** Fakes only `Date`, leaving every timer real so MongoDB and HTTP keep working. */
export function freezeDate(now: Date): void {
  jest.useFakeTimers({
    now,
    doNotFake: [
      "hrtime",
      "nextTick",
      "performance",
      "queueMicrotask",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "requestIdleCallback",
      "cancelIdleCallback",
      "setImmediate",
      "clearImmediate",
      "setInterval",
      "clearInterval",
      "setTimeout",
      "clearTimeout",
    ],
  });
}
