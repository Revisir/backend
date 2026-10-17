import { Router } from "express";
import { getTopics, getTopicById, getDueTopics, getTopicHistory, getForgettingCurve, generateTopicMindMap, getTopicMindMap, markTopicRevised, updateTopic, deleteTopicFile, uploadTopicFiles, deleteTopic, resetTopicProgress } from "@controllers/topicController.js";
// import { upload } from "@middleware/upload";
import { createTopic } from "@controllers/createTopicController.js";
import { requireAIConfig } from "@middleware/aiConfigCheck.js";
import { regenerateQuestions } from "@controllers/questionBankController.js";
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
  // upload.array("files", 10), // Accept up to 10 files with field name 'files'
  createTopic,
);
/**
 * GET /api/topics/due
 * Topics due in the learner's current day (revisionDate before the start of the
 * learner's tomorrow), plus topics already reviewed today, most overdue first.
 * "Today" comes from the X-Local-TimeZone header (IANA zone; UTC if missing or invalid).
 *
 * Every topic also carries the computed review fields (see .claude/docs/api.md):
 * - lastQuality: number | null
 * - estimatedRecall: number (0..1)
 * - nextIntervals: number[6] (days until the next review for a rating 0..5 given now)
 * - questionBank: { state, usableCount, rebuilding }  (never questions, answers or the retired list)
 * - review: { doneToday, normalQuiz: { available, reason, questionCount }, aiQuiz: { available, reason } }
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
 * GET /api/topics/:id/forgetting-curve
 * Get forgetting curve data for a topic
 *
 * Path parameters:
 * - id: string (MongoDB ObjectId)
 *
 * Response:
 * - 200: { topicName, eFactor, interval, repetitionNumber, revisionDate, lastRevised, curvePoints, revisionMarkers }
 * - 400: Invalid topic ID format
 * - 404: Topic not found
 * - 500: Server error
 */
router.get("/:id/forgetting-curve", getForgettingCurve);

/**
 * POST /api/topics/:id/mindmap
 * Generate a  mind map for a topic
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
router.post("/:id/mindmap", requireAIConfig, generateTopicMindMap);

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
router.get("/:id/mindmap", requireAIConfig, getTopicMindMap);

/**
 * POST /api/topics/:id/questions/regenerate
 * Queue a rebuild that replaces the topic's question bank. Flagged questions
 * stay retired, and the current questions stay usable until the new bank lands.
 *
 * Path parameters:
 * - id: string (MongoDB ObjectId)
 *
 * Response:
 * - 202: { questionBank: { state, usableCount, rebuilding } }
 * - 400: Invalid topic ID format
 * - 404: TOPIC_NOT_FOUND
 * - 503: AI_NOT_CONFIGURED
 * - 500: Server error
 */
router.post("/:id/questions/regenerate", requireAIConfig, regenerateQuestions);

/**
 * POST /api/topics/:id/revised
 * Done: record the learner's own rating (method "self") and reschedule with SM-2.
 * One review per topic per learner-day; there is no same-day undo.
 *
 * Path parameters:
 * - id: string (MongoDB ObjectId)
 *
 * Request body:
 * - userQuality: number (required, 0-5)
 *
 * Response:
 * - 200: { success: true, nextRevisionDate: string, lastRevised: string, eFactor: number, interval: number, repetitionNumber: number, lastQuality: number }
 * - 400: VALIDATION_ERROR
 * - 404: TOPIC_NOT_FOUND
 * - 409: ALREADY_REVIEWED_TODAY
 * - 500: Server error
 */
router.post("/:id/revised", markTopicRevised);

/**
 * POST /api/topics/:id/reset
 * Reset topic progress (SM-2 values and revision history)
 *
 * Path parameters:
 * - id: string (MongoDB ObjectId)
 *
 * Response:
 * - 200: { success: true, revisionDate: string }
 * - 400: Invalid topic ID format
 * - 404: Topic not found
 * - 500: Server error
 */
router.post("/:id/reset", resetTopicProgress);

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
 * - urls: string[] (optional) — the full URL list. Existing entries keep their status;
 *   new http(s) URLs are queued for extraction, others are saved as failed;
 *   removed URLs lose their extracted file, and the question bank is rebuilt (or cleared).
 * - dateStudied: string (optional, YYYY-MM-DD or ISO date-time). Resets the schedule and
 *   history only when it differs from the stored date in the learner's zone.
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
 * Upload additional files to topic. Creates a pending entry per file (keyed by its
 * storage path) so it shows on the topic page while it uploads and extracts.
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
 * Delete a specific file from topic. Removing extracted material rebuilds the
 * question bank from what remains, or clears it when nothing remains.
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
 * Get topic details by ID. Every files[] and urls[] entry carries processingStatus,
 * and errorReason when failed.
 *
 * Every topic also carries the computed review fields (see .claude/docs/api.md):
 * - lastQuality: number | null
 * - estimatedRecall: number (0..1)
 * - nextIntervals: number[6] (days until the next review for a rating 0..5 given now)
 * - questionBank: { state, usableCount, rebuilding }  (never questions, answers or the retired list)
 * - review: { doneToday, normalQuiz: { available, reason, questionCount }, aiQuiz: { available, reason } }
 *
 * Path parameters:
 * - id: string (MongoDB ObjectId)
 *
 * Response:
 * - 200: Topic document with the review fields
 * - 400: Invalid topic ID format
 * - 404: Topic not found
 * - 500: Server error
 */
router.get("/:id", getTopicById);

export default router;
