import { Router } from 'express';
import { startChatSession, sendChatMessage, completeChatSession } from '@controllers/chatController.js';
import { requireAIConfig } from '@middleware/aiConfigCheck.js';

const router = Router();
router.use(requireAIConfig);

/**
 * POST /api/chat/start
 * Initialize chat session with topic context
 * 
 * Request body:
 * - topicId: string (MongoDB ObjectId)
 * 
 * Response:
 * - 200: { sessionId: string, initialMessage: string }
 * - 400: Validation error
 * - 404: Topic not found
 * - 500: Server error (S3_ACCESS_ERROR, LLM_UNAVAILABLE, INTERNAL_SERVER_ERROR)
 */
router.post('/start', startChatSession);

/**
 * POST /api/chat/message
 * Send message and get LLM response
 * 
 * Request body:
 * - sessionId: string (MongoDB ObjectId)
 * - message: string
 * 
 * Response:
 * - 200: { response: string }
 * - 400: Validation error or inactive session
 * - 404: Session not found
 * - 500: Server error (LLM_UNAVAILABLE, INTERNAL_SERVER_ERROR)
 */
router.post('/message', sendChatMessage);

/**
 * POST /api/chat/complete
 * Complete revision session and update schedule
 * 
 * Request body:
 * - sessionId: string (MongoDB ObjectId)
 * - topicId: string (MongoDB ObjectId)
 * - userQuality: number (0-5)
 * - llmQuality: number (0-5)
 * 
 * Response:
 * - 200: { nextRevisionDate: string (ISO), finalQuality: number }
 * - 400: Validation error
 * - 404: Session or topic not found
 * - 500: Server error
 */
router.post('/complete', completeChatSession);

export default router;
