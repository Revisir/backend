import { Types } from "mongoose";
import { Topic, type IAttachedFile, type IAttachedUrl, type BankState } from "@models/Topic.js";
import { RevisionRecord } from "@models/RevisionRecord.js";
import { STALE_ATTACHMENT_REASON, allSettled, fileTypeFor, hasCompletedMaterial, isStale, type AttachmentLike } from "@services/attachments.js";
import { extractedKeyForFile, extractedKeyForUrl, parseUploadKey } from "@services/uploadKey.js";
import { filterPublishableUrls } from "@services/topicMaterials.js";
import { logger } from "@config/logger.js";

const log = logger.child({ module: "launchRepair" });

/**
 * One-time launch repair and backfill (KTD13, R20, R40, R41).
 *
 * Before this release, uploaded files never got an entry, URL saves reset
 * extracted URLs to pending, the Lambda URL path never set a status, and no
 * topic kept its last rating or a question bank. Per topic this:
 *
 * 1. creates the missing file entry for each uploaded object — completed when
 *    its extracted object exists, otherwise pending and republished;
 * 2. completes pending (or sweep-timed-out) file and URL entries whose
 *    extracted object exists, and republishes the rest;
 * 3. backfills `lastQuality` from the latest revision record;
 * 4. queues a bank build for topics with completed material, no bank, and no
 *    attachment still on its way (those build when they settle), due first.
 *
 * Never deletes anything and never overwrites a value the learner produced:
 * entries are only added or moved to a truthful status, and `lastQuality` is
 * only set while empty. A second run plans nothing.
 */

export interface UploadedObject {
  key: string;
  size?: number;
  contentType?: string;
}

/** Storage and queue access, injected so the run can be dry, real, or a test. */
export interface RepairDeps {
  /** Every object key under a prefix. */
  listObjects(prefix: string): Promise<UploadedObject[]>;
  /** Content type of an uploaded object, for a new entry's file type. */
  contentTypeOf(key: string): Promise<string | undefined>;
  publishFile(key: string): Promise<boolean>;
  publishUrls(topicId: string, userId: string, urls: string[]): Promise<boolean>;
  queueBankBuild(topicId: string, userId: string): Promise<void>;
}

type RepairTopic = {
  _id: Types.ObjectId;
  userId: string;
  topicName: string;
  revisionDate: Date;
  lastQuality?: number | null;
  files?: IAttachedFile[];
  urls?: IAttachedUrl[];
  questionBank?: { state?: BankState } | null;
};

export interface TopicRepairPlan {
  topicId: string;
  userId: string;
  topicName: string;
  revisionDate: Date;
  newFileEntries: { fileName: string; key: string; status: "completed" | "pending"; extractedPath?: string; contentType: string; size?: number }[];
  completeFiles: { key: string; extractedPath: string }[];
  republishFiles: string[];
  completeUrls: { url: string; extractedPath: string }[];
  republishUrls: string[];
  lastQuality: number | null;
  /** Decided after the attachment repairs are applied. */
  queueBank: boolean;
}

export interface RepairReport {
  dryRun: boolean;
  topicsScanned: number;
  topicsChanged: number;
  fileEntriesCreated: number;
  filesCompleted: number;
  filesRepublished: number;
  urlsCompleted: number;
  urlsRepublished: number;
  lastQualityBackfilled: number;
  bankBuildsQueued: number;
  /** Per changed topic, for the dry-run review. */
  plans: TopicRepairPlan[];
}

/** An entry that is stuck: pending or processing past the window, or failed by the sweep for it. */
function isStuck(att: AttachmentLike & { errorReason?: string | null }, now: Date): boolean {
  if (att.processingStatus === "failed") return att.errorReason === STALE_ATTACHMENT_REASON;
  return isStale(att, now);
}

/**
 * Plans one topic's attachment and rating repairs. Pure.
 * `contentTypes` holds the content type of every upload that has no entry.
 */
export function planTopicRepair(input: {
  topic: RepairTopic;
  uploads: UploadedObject[];
  extractedKeys: ReadonlySet<string>;
  latestQuality: number | null | undefined;
  now: Date;
}): TopicRepairPlan {
  const { topic, uploads, extractedKeys, latestQuality, now } = input;
  const topicId = topic._id.toString();
  const files = topic.files ?? [];
  const urls = topic.urls ?? [];
  const entryKeys = new Set(files.map((f) => f.s3Path));

  const plan: TopicRepairPlan = {
    topicId,
    userId: topic.userId,
    topicName: topic.topicName,
    revisionDate: topic.revisionDate,
    newFileEntries: [],
    completeFiles: [],
    republishFiles: [],
    completeUrls: [],
    republishUrls: [],
    lastQuality: null,
    queueBank: false,
  };

  for (const upload of uploads) {
    const parsed = parseUploadKey(upload.key);
    if (!parsed || entryKeys.has(upload.key)) continue;
    const extractedPath = extractedKeyForFile(topic.userId, topicId, parsed.fileName);
    const contentType = upload.contentType ?? "application/octet-stream";
    if (extractedKeys.has(extractedPath)) {
      plan.newFileEntries.push({ fileName: parsed.fileName, key: upload.key, status: "completed", extractedPath, contentType, size: upload.size });
    } else {
      plan.newFileEntries.push({ fileName: parsed.fileName, key: upload.key, status: "pending", contentType, size: upload.size });
      plan.republishFiles.push(upload.key);
    }
  }

  const uploadedKeys = new Set(uploads.map((u) => u.key));
  for (const file of files) {
    if (!isStuck(file, now)) continue;
    const parsed = parseUploadKey(file.s3Path);
    const extractedPath = file.extractedContentUrl || (parsed ? extractedKeyForFile(topic.userId, topicId, parsed.fileName) : null);
    if (extractedPath && extractedKeys.has(extractedPath)) plan.completeFiles.push({ key: file.s3Path, extractedPath });
    else if (uploadedKeys.has(file.s3Path)) plan.republishFiles.push(file.s3Path);
    // An entry whose object was never uploaded stays as it is; the sweep fails it.
  }

  for (const url of urls) {
    if (!isStuck(url, now)) continue;
    const extractedPath = url.extractedContentPath || extractedKeyForUrl(topic.userId, topicId, url.url);
    if (extractedKeys.has(extractedPath)) plan.completeUrls.push({ url: url.url, extractedPath });
    else if (filterPublishableUrls([url.url]).length) plan.republishUrls.push(url.url);
  }

  if (topic.lastQuality == null && latestQuality != null) plan.lastQuality = latestQuality;
  return plan;
}

function hasChanges(plan: TopicRepairPlan): boolean {
  return (
    plan.newFileEntries.length + plan.completeFiles.length + plan.republishFiles.length + plan.completeUrls.length + plan.republishUrls.length > 0 ||
    plan.lastQuality !== null ||
    plan.queueBank
  );
}

/** Applies one topic's attachment and rating repairs. */
async function applyTopicRepair(plan: TopicRepairPlan, bucket: string, deps: RepairDeps, now: Date): Promise<void> {
  const { topicId, userId } = plan;

  for (const entry of plan.newFileEntries) {
    await Topic.updateOne(
      { _id: topicId, userId, "files.s3Path": { $ne: entry.key } },
      {
        $push: {
          files: {
            fileName: entry.fileName,
            fileType: fileTypeFor(entry.contentType),
            s3Path: entry.key,
            s3Bucket: bucket,
            size: entry.size ?? null,
            extractedContentUrl: entry.extractedPath ?? null,
            processingStatus: entry.status,
            statusUpdatedAt: now,
            processedAt: now,
          },
        },
      },
    );
  }

  for (const file of plan.completeFiles) {
    await Topic.updateOne(
      { _id: topicId, userId, "files.s3Path": file.key },
      { $set: { "files.$.processingStatus": "completed", "files.$.extractedContentUrl": file.extractedPath, "files.$.statusUpdatedAt": now, "files.$.errorReason": null } },
    );
  }

  for (const url of plan.completeUrls) {
    await Topic.updateOne(
      { _id: topicId, userId, "urls.url": url.url },
      { $set: { "urls.$.processingStatus": "completed", "urls.$.extractedContentPath": url.extractedPath, "urls.$.statusUpdatedAt": now, "urls.$.errorReason": null } },
    );
  }

  // Republished attachments restart their staleness window as pending.
  for (const key of plan.republishFiles) {
    await Topic.updateOne(
      { _id: topicId, userId, "files.s3Path": key },
      { $set: { "files.$.processingStatus": "pending", "files.$.statusUpdatedAt": now, "files.$.errorReason": null } },
    );
    if (!(await deps.publishFile(key))) log.error({ topicId, key }, "Failed to republish file for extraction");
  }
  if (plan.republishUrls.length) {
    await Topic.updateOne(
      { _id: topicId, userId },
      { $set: { "urls.$[elem].processingStatus": "pending", "urls.$[elem].statusUpdatedAt": now, "urls.$[elem].errorReason": null } },
      { arrayFilters: [{ "elem.url": { $in: plan.republishUrls } }] },
    );
    if (!(await deps.publishUrls(topicId, userId, plan.republishUrls))) log.error({ topicId }, "Failed to republish URLs for extraction");
  }

  if (plan.lastQuality !== null) {
    await Topic.updateOne({ _id: topicId, userId, lastQuality: null }, { $set: { lastQuality: plan.lastQuality } });
  }
}

/**
 * The topic as it will look after the plan, for the bank decision. In a dry
 * run nothing is written, so the post-repair state is simulated.
 */
function afterRepair(topic: RepairTopic, plan: TopicRepairPlan, now: Date): RepairTopic {
  const completedFiles = new Map(plan.completeFiles.map((f) => [f.key, f.extractedPath]));
  const completedUrls = new Map(plan.completeUrls.map((u) => [u.url, u.extractedPath]));
  const republishedFiles = new Set(plan.republishFiles);
  const republishedUrls = new Set(plan.republishUrls);
  const files = [
    ...(topic.files ?? []).map((f) =>
      completedFiles.has(f.s3Path)
        ? { ...f, processingStatus: "completed" as const, extractedContentUrl: completedFiles.get(f.s3Path) }
        : republishedFiles.has(f.s3Path)
          ? { ...f, processingStatus: "pending" as const, statusUpdatedAt: now }
          : f,
    ),
    ...plan.newFileEntries.map((e) => ({ s3Path: e.key, fileName: e.fileName, processingStatus: e.status, extractedContentUrl: e.extractedPath, statusUpdatedAt: now }) as IAttachedFile),
  ];
  const urls = (topic.urls ?? []).map((u) =>
    completedUrls.has(u.url)
      ? { ...u, processingStatus: "completed" as const, extractedContentPath: completedUrls.get(u.url) }
      : republishedUrls.has(u.url)
        ? { ...u, processingStatus: "pending" as const, statusUpdatedAt: now }
        : u,
  );
  return { ...topic, files, urls };
}

/**
 * Runs the repair across every topic (or one user's). In a dry run nothing is
 * written or published, and the report holds the same plan a real run makes.
 */
export async function runLaunchRepair(options: { dryRun: boolean; bucket: string; deps: RepairDeps; userId?: string; now?: Date }): Promise<RepairReport> {
  const { dryRun, bucket, deps, userId, now = new Date() } = options;
  const report: RepairReport = {
    dryRun,
    topicsScanned: 0,
    topicsChanged: 0,
    fileEntriesCreated: 0,
    filesCompleted: 0,
    filesRepublished: 0,
    urlsCompleted: 0,
    urlsRepublished: 0,
    lastQualityBackfilled: 0,
    bankBuildsQueued: 0,
    plans: [],
  };

  const cursor = Topic.find(userId ? { userId } : {})
    .select("userId topicName revisionDate lastQuality files urls questionBank.state")
    .sort({ _id: 1 })
    .lean()
    .cursor();

  const bankCandidates: TopicRepairPlan[] = [];
  for await (const doc of cursor) {
    const topic = doc as unknown as RepairTopic;
    report.topicsScanned += 1;
    const topicId = topic._id.toString();
    const prefix = `${topic.userId}/${topicId}`;

    const [stored, latest] = await Promise.all([
      deps.listObjects(`${prefix}/`),
      topic.lastQuality == null ? RevisionRecord.findOne({ userId: topic.userId, topicId: topic._id }).sort({ revisionDate: -1 }).select("finalQuality").lean() : null,
    ]);
    const extractedKeys = new Set(stored.filter((o) => o.key.startsWith(`${prefix}/extracted/`)).map((o) => o.key));
    const entryKeys = new Set((topic.files ?? []).map((f) => f.s3Path));
    const uploads = await Promise.all(
      stored
        .filter((o) => o.key.startsWith(`${prefix}/files/`))
        .map(async (o) => (entryKeys.has(o.key) ? o : { ...o, contentType: await deps.contentTypeOf(o.key) })),
    );

    const plan = planTopicRepair({ topic, uploads, extractedKeys, latestQuality: latest?.finalQuality, now });
    const repaired = afterRepair(topic, plan, now);
    const bankState = topic.questionBank?.state ?? "none";
    plan.queueBank = bankState === "none" && hasCompletedMaterial(repaired) && allSettled(repaired, now);
    if (!hasChanges(plan)) continue;

    report.topicsChanged += 1;
    report.fileEntriesCreated += plan.newFileEntries.length;
    report.filesCompleted += plan.completeFiles.length;
    report.filesRepublished += plan.republishFiles.length;
    report.urlsCompleted += plan.completeUrls.length;
    report.urlsRepublished += plan.republishUrls.length;
    if (plan.lastQuality !== null) report.lastQualityBackfilled += 1;
    report.plans.push(plan);
    if (plan.queueBank) bankCandidates.push(plan);

    if (!dryRun) await applyTopicRepair(plan, bucket, deps, now);
  }

  // Due topics first: they are the ones a learner will try to quiz on soonest.
  bankCandidates.sort((a, b) => a.revisionDate.getTime() - b.revisionDate.getTime());
  for (const plan of bankCandidates) {
    report.bankBuildsQueued += 1;
    if (!dryRun) await deps.queueBankBuild(plan.topicId, plan.userId);
  }

  return report;
}
