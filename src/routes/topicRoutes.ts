import { Router } from "express";
import { getTopics, getTopicById, getDueTopics, getTopicHistory, generateTopicMindMap, getTopicMindMap, markTopicRevised, updateTopic, deleteTopicFile, uploadTopicFiles, deleteTopic } from "@controllers/topicController";
import { upload } from "@middleware/upload";
import { createTopic } from "@controllers/createTopicController";
const router = Router();

/**
 * GET /api/topics
 * List all topics with pagination and optional subject filter
 *
 * Query parameters:
 * - page: number (optional, default: 1, min: 1)
 * - limit: number (optional, default: 10, min: 1, max: 100)
 * - subject: string (optional, filter by subject name)
 *
 * Response:
 * - 200: { topics: Topic[], total: number, page: number }
 * - 400: Validation error
 * - 500: Server error
 */
router.get("/", getTopics);
/**
 * POST /api/topics
 * Create a new topic with optional file attachments
 *
 * Request body (multipart/form-data):
 * - topicName: string (required, max 200 chars)
 * - subjectName: string (required, max 100 chars)
 * - description: string (optional)
 * - dateStudied: string (required, ISO date format)
 * - files: File[] (optional, max 10 files, 10MB each)
 *
 * Response:
 * - 201: { topicId: string, revisionDate: string }
 * - 400: Validation error
 * - 500: Server error
 */
router.post(
  "/",
  upload.array("files", 10), // Accept up to 10 files with field name 'files'
  createTopic,
);
/**
 * GET /api/topics/due
 * Get topics due for revision (revisionDate <= currentDate)
 *
 * Response:
 * - 200: { topics: Topic[] }
 * - 500: Server error
 */
router.get("/due", getDueTopics);

/**
 * GET /api/topics/:id/history
 * Get revision history for a topic
 *
 * Path parameters:
 * - id: string (MongoDB ObjectId)
 *
 * Response:
 * - 200: { history: RevisionRecord[] }
 * - 400: Invalid topic ID format
 * - 404: Topic not found
 * - 500: Server error
 */
router.get("/:id/history", getTopicHistory);

/**
 * POST /api/topics/:id/mindmap
 * Generate a Mermaid mind map for a topic
 *
 * Path parameters:
 * - id: string (MongoDB ObjectId)
 *
 * Response:
 * - 200: { mindmap: string, generatedAt: string (ISO) }
 * - 400: Invalid topic ID format
 * - 404: Topic not found
 * - 500: Server error (S3_ACCESS_ERROR, LLM_UNAVAILABLE, VALIDATION_ERROR, INTERNAL_SERVER_ERROR)
 */
router.post("/:id/mindmap", generateTopicMindMap);

/**
 * GET /api/topics/:id/mindmap
 * Retrieve existing mind map for a topic
 *
 * Path parameters:
 * - id: string (MongoDB ObjectId)
 *
 * Response:
 * - 200: { mindmap: string, generatedAt: string (ISO) | null }
 * - 400: Invalid topic ID format
 * - 404: Topic not found or mind map not generated
 * - 500: Server error
 */
router.get("/:id/mindmap", getTopicMindMap);

/**
 * POST /api/topics/:id/revised
 * Mark topic as revised and create revision record with SM-2 algorithm
 *
 * Path parameters:
 * - id: string (MongoDB ObjectId)
 *
 * Request body:
 * - userQuality: number (required, 1-5)
 * - llmQuality: number (optional, 1-5)
 *
 * Response:
 * - 200: { success: true, nextRevisionDate: string, newInterval: number, newEFactor: number }
 * - 400: Validation error
 * - 404: Topic not found
 * - 500: Server error
 */
router.post("/:id/revised", markTopicRevised);

/**
 * PATCH /api/topics/:id
 * Update topic details
 *
 * Path parameters:
 * - id: string (MongoDB ObjectId)
 *
 * Request body:
 * - topicName: string (optional, max 200 chars)
 * - subjectName: string (optional, max 100 chars)
 * - description: string (optional)
 * - dateStudied: string (optional, ISO date)
 *
 * Response:
 * - 200: { success: true, topic: Topic }
 * - 400: Validation error
 * - 404: Topic not found
 * - 500: Server error
 */
router.patch("/:id", updateTopic);

/**
 * POST /api/topics/:id/files
 * Upload additional files to topic
 *
 * Path parameters:
 * - id: string (MongoDB ObjectId)
 *
 * Request body:
 * - files: Array<{ fileName: string, size: number, contentType: string }>
 *
 * Response:
 * - 200: { uploadUrls: Array<{ fileName: string, uploadUrl: string }> }
 * - 400: Validation error
 * - 404: Topic not found
 * - 500: Server error
 */
router.post("/:id/files", uploadTopicFiles);

/**
 * DELETE /api/topics/:id/files/:fileId
 * Delete a specific file from topic
 *
 * Path parameters:
 * - id: string (MongoDB ObjectId)
 * - fileId: string (File ObjectId)
 *
 * Response:
 * - 200: { success: true }
 * - 404: Topic or file not found
 * - 500: Server error
 */
router.delete("/:id/files/:fileId", deleteTopicFile);

/**
 * DELETE /api/topics/:id
 * Delete a topic and all its revision records
 *
 * Path parameters:
 * - id: string (MongoDB ObjectId)
 *
 * Response:
 * - 200: { success: true }
 * - 400: Invalid topic ID format
 * - 404: Topic not found
 * - 500: Server error
 */
router.delete("/:id", deleteTopic);

/**
 * GET /api/topics/:id
 * Get topic details by ID
 *
 * Path parameters:
 * - id: string (MongoDB ObjectId)
 *
 * Response:
 * - 200: Topic document
 * - 400: Invalid topic ID format
 * - 404: Topic not found
 * - 500: Server error
 */
router.get("/:id", getTopicById);

export default router;
