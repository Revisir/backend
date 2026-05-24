import dotenv from "dotenv";
// Load environment variables
dotenv.config();

import express from "express";
import cors from "cors";
import { connectDatabase } from "@config/database";
import { optionalAuth } from "@middleware/auth";
import topicRoutes from "@routes/topicRoutes";
import statisticsRoutes from "@routes/statisticsRoutes";
import chatRoutes from "@routes/chatRoutes";
import subjectRoutes from "@routes/subjectRoutes";

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

// Apply authentication middleware to all API routes
app.use("/api", optionalAuth);

// API Routes (all protected by authentication)
app.use("/api/topics", topicRoutes);
app.use("/api/statistics", statisticsRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/subjects", subjectRoutes);

// Start server
const startServer = async () => {
  try {
    // Connect to MongoDB
    await connectDatabase();

    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

startServer();
