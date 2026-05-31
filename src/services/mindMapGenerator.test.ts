import { buildMindMapPrompt, generateMindMap } from './mindMapGenerator';
import { ITopic } from '../models/Topic';
import * as s3Storage from './s3Storage';
import * as llmClient from './llmClient';

jest.mock('./s3Storage');
jest.mock('./llmClient');

describe('Mind Map Generator', () => {
  const mockTopic = {
    _id: 'topic123' as any,
    topicName: 'Photosynthesis',
    subjectName: 'Biology',
    description: 'The process by which plants convert light energy into chemical energy',
    userId: 'user123',
    dateStudied: new Date('2024-01-15'),
    revisionDate: new Date('2024-01-16'),
    eFactor: 2.5,
    repetitionNumber: 0,
    interval: 1,
    files: [],
    mindMap: null,
    mindMapGeneratedAt: null,
    createdAt: new Date('2024-01-15'),
    updatedAt: new Date('2024-01-15')
  } as unknown as ITopic;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('buildMindMapPrompt', () => {
    it('should build a prompt with extracted content from S3 folder', async () => {
      (s3Storage.getAllExtractedContent as jest.Mock).mockResolvedValue(
        '\n### notes.pdf.md\nPhotosynthesis occurs in chloroplasts.'
      );

      const prompt = await buildMindMapPrompt(mockTopic);

      expect(prompt).toContain('Photosynthesis occurs in chloroplasts');
      expect(prompt).toContain('MindElixir');
      expect(s3Storage.getAllExtractedContent).toHaveBeenCalledWith('user123', 'topic123');
    });

    it('should handle no extracted content', async () => {
      (s3Storage.getAllExtractedContent as jest.Mock).mockResolvedValue('');

      const prompt = await buildMindMapPrompt(mockTopic);

      expect(prompt).toContain('[No study materials attached]');
    });
  });

  describe('generateMindMap', () => {
    beforeEach(() => {
      (s3Storage.getAllExtractedContent as jest.Mock).mockResolvedValue('Study content');
    });

    it('should return valid MindElixir JSON', async () => {
      const validResponse = JSON.stringify({
        nodeData: { id: 'root', topic: 'Photosynthesis', root: true, children: [] }
      });

      const mockLLMClient = { sendTextPrompt: jest.fn().mockResolvedValue(validResponse) };
      (llmClient.getLLMClient as jest.Mock).mockReturnValue(mockLLMClient);

      const result = await generateMindMap(mockTopic);

      expect(JSON.parse(result)).toHaveProperty('nodeData');
    });

    it('should throw error if LLM returns invalid JSON', async () => {
      const mockLLMClient = { sendTextPrompt: jest.fn().mockResolvedValue('not json') };
      (llmClient.getLLMClient as jest.Mock).mockReturnValue(mockLLMClient);

      await expect(generateMindMap(mockTopic)).rejects.toThrow('Invlaid Elixir mind map');
    });

    it('should handle LLM errors', async () => {
      const mockLLMClient = { sendTextPrompt: jest.fn().mockRejectedValue(new Error('LLM timeout')) };
      (llmClient.getLLMClient as jest.Mock).mockReturnValue(mockLLMClient);

      await expect(generateMindMap(mockTopic)).rejects.toThrow('LLM timeout');
    });
  });
});
