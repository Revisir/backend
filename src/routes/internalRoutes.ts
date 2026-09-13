import { Router } from "express";
import { handleStorageWebhook } from "@controllers/storageWebhookController.js";

const router = Router();

/**
 * POST /internal/storage-webhook
 * Receives SeaweedFS filer notifications for uploaded objects.
 *
 * Cluster-internal only: the reverse proxy exposes /api and /storage, not
 * /internal, and no authentication middleware runs on this path.
 */
router.post("/storage-webhook", handleStorageWebhook);

export default router;
