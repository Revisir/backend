import "dotenv/config";

import express from "express";
import cors from "cors";
import { connectDatabase } from "@config/database.js";
import { logger } from "@config/logger.js";
import { optionalAuth } from "@middleware/auth.js";
import topicRoutes from "@routes/topicRoutes.js";
import statisticsRoutes from "@routes/statisticsRoutes.js";
import chatRoutes from "@routes/chatRoutes.js";
import subjectRoutes from "@routes/subjectRoutes.js";
import internalRoutes from "@routes/internalRoutes.js";
import quizRoutes from "@routes/quizRoutes.js";
import { initRabbitMQ, Publishers } from "@services/rabbitmq/index.js";

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint (no authentication required)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", message: "Revision Study Reminder API is running" });
});


// Storage notifications from SeaweedFS (cluster-internal, not proxied publicly)
app.use("/internal", internalRoutes);

// Apply authentication middleware to all API routes
app.use("/api", optionalAuth);

// API Routes (all protected by authentication)
app.use("/api/topics", topicRoutes);
app.use("/api/statistics", statisticsRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/subjects", subjectRoutes);
app.use("/api/quiz", quizRoutes);

// Start server
const startServer = async () => {
  try {
    await connectDatabase();
    await initRabbitMQ();

    logger.info("RabbitMQ initialized and queues declared");

    app.listen(PORT, () => {
      logger.info({ port: PORT, env: process.env.NODE_ENV }, "Server is running");
    });
  } catch (error) {
    logger.fatal({ err: error }, "Failed to start server");
    process.exit(1);
  }
};

startServer();

const gracefulShutdown = async (signal: string) => {
  logger.info({ signal }, "Received shutdown signal");
  if (Publishers.connectionManager) {
    await Publishers.connectionManager.shutdown();
  }
  process.exit(0);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
