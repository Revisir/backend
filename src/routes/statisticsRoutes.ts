import { Router } from 'express';
import { getStatistics } from '@controllers/statisticsController.js';

const router = Router();

/**
 * GET /api/statistics
 * Get dashboard statistics
 * 
 * Response:
 * - 200: {
 *     totalTopics: number,
 *     dueToday: number,
 *     revisedThisWeek: number,
 *     revisedThisMonth: number,
 *     upcomingRevisions: { date: string, count: number }[]
 *   }
 * - 500: Server error
 */
router.get('/', getStatistics);

export default router;
