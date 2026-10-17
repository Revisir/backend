import { Request, Response } from "express";

// Mock @/schemas/index before importing the controller (avoids relative .js resolution)
jest.mock("@/schemas/index", () => {
  const { z: zod } = jest.requireActual("zod");
  const fileInfoSchema = zod.object({
    fileName: zod.string().min(1),
    size: zod.number().positive(),
    contentType: zod.string().min(1),
  });
  return {
    createTopicSchema: zod.object({
      topicName: zod.string().trim().min(1).max(200),
      subjectName: zod.string().trim().min(1).max(100),
      description: zod.string().trim().max(1000).optional(),
      urls: zod.array(zod.string().url()).min(1).max(20).optional(),
      files: zod.array(fileInfoSchema).optional(),
      dateStudied: zod
        .string()
        .refine((val: string) => !isNaN(Date.parse(val)))
        .refine((val: string) => new Date(val) <= new Date()),
    }),
  };
});

jest.mock("@models/Topic", () => {
  const mockSave = jest.fn().mockResolvedValue(undefined);
  const MockTopic = jest.fn().mockImplementation((data: any) => ({
    ...data,
    _id: { toString: () => "mock-topic-id-123" },
    topicName: data.topicName,
    subjectName: data.subjectName,
    description: data.description || "",
    dateStudied: new Date(data.dateStudied),
    revisionDate: data.revisionDate,
    isDue: false,
    save: mockSave,
  }));
  return { Topic: MockTopic, __mockSave: mockSave };
});

jest.mock("@services/sm2Algorithm", () => ({
  calculateNextReview: jest.fn().mockReturnValue({
    eFactor: 2.5,
    repetitionNumber: 1,
    interval: 1,
    nextRevisionDate: new Date("2024-06-01"),
  }),
}));

jest.mock("@services/s3Storage", () => ({
  generatePresignedUploadUrl: jest.fn().mockResolvedValue(
    "https://s3.example.com/presigned-url"
  ),
}));

jest.mock("@config/logger", () => ({
  logger: {
    child: () => ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    }),
  },
}));

// Must also mock $types since they use .js extensions in barrel
jest.mock("$types/createTopic.types", () => ({}));
jest.mock("$types/common.types", () => ({}));

// Import controller after mocks
import { createTopic } from "@controllers/createTopicController";
import { filterPublishableUrls } from "@services/topicMaterials";
import { Publishers } from "@services/rabbitmq/index";

function createMockReq(body: unknown): Request {
  return { body, userId: "test-user-id" } as unknown as Request;
}

function createMockRes(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

describe("createTopicController - RabbitMQ publishing", () => {
  let mockPublisher: { publish: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPublisher = {
      publish: jest.fn().mockResolvedValue(true),
    };
    Publishers.url = mockPublisher as any;
  });

  describe("Publish on valid URLs", () => {
    it("should call publisher.publish with correct queue, topicId, userId, and filtered URLs", async () => {
      const req = createMockReq({
        topicName: "Test Topic",
        subjectName: "Mathematics",
        dateStudied: new Date().toISOString(),
        urls: ["https://example.com/article", "http://docs.example.org/page"],
      });
      const res = createMockRes();

      await createTopic(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      expect(mockPublisher.publish).toHaveBeenCalledWith({
        message: {
          topicId: "mock-topic-id-123",
          userId: "test-user-id",
          urls: ["https://example.com/article", "http://docs.example.org/page"],
        },
      });
    });

    it("should only publish http/https URLs when mixed schemes are present", async () => {
      const req = createMockReq({
        topicName: "Mixed URLs Topic",
        subjectName: "Science",
        dateStudied: new Date().toISOString(),
        urls: [
          "https://valid.com/page",
          "http://also-valid.com/article",
          "ftp://invalid.example.com/file",
          "mailto:user@example.com",
        ],
      });
      const res = createMockRes();

      await createTopic(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      expect(mockPublisher.publish).toHaveBeenCalledWith({
        message: {
          topicId: "mock-topic-id-123",
          userId: "test-user-id",
          urls: ["https://valid.com/page", "http://also-valid.com/article"],
        },
      });
    });
  });

  describe("Skip publish when no http/https URLs", () => {
    it("should NOT call publisher.publish when only non-http URLs are provided", async () => {
      const req = createMockReq({
        topicName: "FTP Topic",
        subjectName: "Computing",
        dateStudied: new Date().toISOString(),
        urls: ["ftp://files.example.com/doc.pdf"],
      });
      const res = createMockRes();

      await createTopic(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it("should NOT call publisher.publish when no URLs are provided", async () => {
      const req = createMockReq({
        topicName: "No URLs Topic",
        subjectName: "Physics",
        dateStudied: new Date().toISOString(),
      });
      const res = createMockRes();

      await createTopic(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it("should NOT call publisher.publish when only mailto URLs are provided", async () => {
      const req = createMockReq({
        topicName: "Mailto Topic",
        subjectName: "English",
        dateStudied: new Date().toISOString(),
        urls: ["mailto:someone@example.com", "mailto:other@test.org"],
      });
      const res = createMockRes();

      await createTopic(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });
  });

  describe("Graceful handling of publish failure", () => {
    it("should still return 201 when publisher.publish throws an error", async () => {
      mockPublisher.publish.mockRejectedValue(
        new Error("RabbitMQ connection lost")
      );

      const req = createMockReq({
        topicName: "Publish Failure Topic",
        subjectName: "Chemistry",
        dateStudied: new Date().toISOString(),
        urls: ["https://example.com/article"],
      });
      const res = createMockRes();

      await createTopic(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalled();
    });

    it("should still return 201 when publisher.publish returns false", async () => {
      mockPublisher.publish.mockResolvedValue(false);

      const req = createMockReq({
        topicName: "Publish Returns False Topic",
        subjectName: "Biology",
        dateStudied: new Date().toISOString(),
        urls: ["https://example.com/page"],
      });
      const res = createMockRes();

      await createTopic(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalled();
    });

    it("should still include topic data in response when publish fails", async () => {
      mockPublisher.publish.mockRejectedValue(new Error("Channel closed"));

      const req = createMockReq({
        topicName: "Response Still Works",
        subjectName: "History",
        dateStudied: new Date().toISOString(),
        urls: ["https://example.com/history-article"],
      });
      const res = createMockRes();

      await createTopic(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const responseBody = (res.json as jest.Mock).mock.calls[0][0];
      expect(responseBody.topicId).toBe("mock-topic-id-123");
      expect(responseBody.topicName).toBe("Response Still Works");
      expect(responseBody.subjectName).toBe("History");
    });
  });

  describe("filterPublishableUrls helper", () => {
    it("should return only http and https URLs", () => {
      const urls = [
        "https://example.com",
        "http://test.org",
        "ftp://files.com",
        "mailto:a@b.com",
      ];
      expect(filterPublishableUrls(urls)).toEqual([
        "https://example.com",
        "http://test.org",
      ]);
    });

    it("should return empty array when no URLs match", () => {
      const urls = ["ftp://a.com", "mailto:b@c.com"];
      expect(filterPublishableUrls(urls)).toEqual([]);
    });

    it("should return all URLs when all are http/https", () => {
      const urls = ["http://a.com", "https://b.com"];
      expect(filterPublishableUrls(urls)).toEqual([
        "http://a.com",
        "https://b.com",
      ]);
    });

    it("should return empty array for empty input", () => {
      expect(filterPublishableUrls([])).toEqual([]);
    });
  });
});
