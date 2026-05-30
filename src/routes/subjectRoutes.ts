import { Router } from 'express';
import { getSubjects } from '@controllers/subjectController.js';

const router = Router();

/**
 * GET /api/subjects
 * Fetch unique subjects for authenticated user
 */
router.get('/', getSubjects);

export default router;
