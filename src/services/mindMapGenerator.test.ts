import { buildMindMapPrompt, generateMindMap } from './mindMapGenerator';
import { ITopic } from '../models/Topic';
import * as s3Storage from './s3Storage';
import * as llmClient from './llmClient';

// Mock dependencies
jest.mock('./s3Storage');
jest.mock('./llmClient');

describe('Mind Map Generator', () => {
  const mockTopic = {
    _id: 'topic123' as any,
    topicName: 'Photosynthesis',
    subjectName: 'Biology',
    description: 'The process by which plants convert light energy into chemical energy',
    dateStudied: new Date('2024-01-15'),
    revisionDate: new Date('2024-01-16'),
    eFactor: 2.5,
    repetitionNumber: 0,
    interval: 1,
    files: [
      {
        _id: 'file1' as any,
        fileName: 'photosynthesis-notes.pdf',
        fileType: 'pdf' as const,
        fileUrl: 'https://example.com/file1.pdf',
        s3Path: 'topic123/extracted-content-1.md',
        s3Bucket: 'test-bucket',
        extractedContentUrl: 'https://s3.example.com/topic123/extracted-content-1.md',
        processedAt: new Date('2024-01-15')
      }
    ],
    mindMap: null,
    mindMapGeneratedAt: null,
    createdAt: new Date('2024-01-15'),
    updatedAt: new Date('2024-01-15')
  } as unknown as ITopic;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('buildMindMapPrompt', () => {
    it('should build a prompt with topic information and extracted content', async () => {
      // Mock S3 content retrieval
      (s3Storage.getExtractedContent as jest.Mock).mockResolvedValue(
        'Photosynthesis occurs in chloroplasts. Key stages: light reactions and Calvin cycle.'
      );

      const prompt = await buildMindMapPrompt(mockTopic);

      expect(prompt).toContain('Topic: Photosynthesis');
      expect(prompt).toContain('Subject: Biology');
      expect(prompt).toContain('Description: The process by which plants convert light energy into chemical energy');
      expect(prompt).toContain('photosynthesis-notes.pdf');
      expect(prompt).toContain('Photosynthesis occurs in chloroplasts');
      expect(prompt).toContain('mindmap');
      expect(prompt).toContain('root(Photosynthesis)');
      expect(s3Storage.getExtractedContent).toHaveBeenCalledWith('topic123/extracted-content-1.md');
    });

    it('should handle topics without description', async () => {
      const topicWithoutDesc = { ...mockTopic, description: '' } as unknown as ITopic;
      (s3Storage.getExtractedContent as jest.Mock).mockResolvedValue('Content');

      const prompt = await buildMindMapPrompt(topicWithoutDesc);

      expect(prompt).toContain('[No description provided]');
    });

    it('should handle topics without files', async () => {
      const topicWithoutFiles = { ...mockTopic, files: [] } as unknown as ITopic;

      const prompt = await buildMindMapPrompt(topicWithoutFiles);

      expect(prompt).toContain('[No study materials attached]');
      expect(s3Storage.getExtractedContent).not.toHaveBeenCalled();
    });

    it('should continue if S3 content retrieval fails for a file', async () => {
      (s3Storage.getExtractedContent as jest.Mock).mockRejectedValue(
        new Error('S3 error')
      );

      const prompt = await buildMindMapPrompt(mockTopic);

      expect(prompt).toContain('[Content unavailable]');
      expect(prompt).toContain('photosynthesis-notes.pdf');
    });

    it('should handle multiple files', async () => {
      const topicWithMultipleFiles = {
        ...mockTopic,
        files: [
          mockTopic.files[0],
          {
            _id: 'file2' as any,
            fileName: 'diagram.png',
            fileType: 'image' as const,
            fileUrl: 'https://example.com/diagram.png',
            s3Path: 'topic123/extracted-content-2.md',
            s3Bucket: 'test-bucket',
            extractedContentUrl: 'https://s3.example.com/topic123/extracted-content-2.md',
            processedAt: new Date('2024-01-15')
          }
        ]
      } as unknown as ITopic;

      (s3Storage.getExtractedContent as jest.Mock)
        .mockResolvedValueOnce('Content from PDF')
        .mockResolvedValueOnce('Content from image');

      const prompt = await buildMindMapPrompt(topicWithMultipleFiles);

      expect(prompt).toContain('photosynthesis-notes.pdf');
      expect(prompt).toContain('diagram.png');
      expect(prompt).toContain('Content from PDF');
      expect(prompt).toContain('Content from image');
    });
  });

  describe('generateMindMap', () => {
    beforeEach(() => {
      (s3Storage.getExtractedContent as jest.Mock).mockResolvedValue('Study content');
    });

    it('should generate a valid Mermaid mind map', async () => {
      const mockLLMClient = {
        sendTextPrompt: jest.fn().mockResolvedValue(`mindmap
  root(Photosynthesis)
    Light Reactions
      Chlorophyll
      ATP Production
    Calvin Cycle
      Carbon Fixation
      Sugar Formation`)
      };

      (llmClient.getLLMClient as jest.Mock).mockReturnValue(mockLLMClient);

      const result = await generateMindMap(mockTopic);

      expect(result).toContain('mindmap');
      expect(result).toContain('root(Photosynthesis)');
      expect(result).toContain('Light Reactions');
      expect(result).toContain('Calvin Cycle');
      expect(mockLLMClient.sendTextPrompt).toHaveBeenCalledWith(
        expect.stringContaining('Topic: Photosynthesis')
      );
    });

    it('should extract Mermaid code from markdown code blocks', async () => {
      const mockLLMClient = {
        sendTextPrompt: jest.fn().mockResolvedValue(`Here's the mind map:

\`\`\`mermaid
mindmap
  root(Photosynthesis)
    Light Reactions
    Calvin Cycle
\`\`\`

This shows the main concepts.`)
      };

      (llmClient.getLLMClient as jest.Mock).mockReturnValue(mockLLMClient);

      const result = await generateMindMap(mockTopic);

      expect(result).toContain('mindmap');
      expect(result).toContain('root(Photosynthesis)');
      expect(result).not.toContain('```');
      expect(result).not.toContain("Here's the mind map");
    });

    it('should extract Mermaid code from plain code blocks', async () => {
      const mockLLMClient = {
        sendTextPrompt: jest.fn().mockResolvedValue(`\`\`\`
mindmap
  root(Photosynthesis)
    Light Reactions
\`\`\``)
      };

      (llmClient.getLLMClient as jest.Mock).mockReturnValue(mockLLMClient);

      const result = await generateMindMap(mockTopic);

      expect(result).toContain('mindmap');
      expect(result).not.toContain('```');
    });

    it('should throw error if LLM returns empty response', async () => {
      const mockLLMClient = {
        sendTextPrompt: jest.fn().mockResolvedValue('')
      };

      (llmClient.getLLMClient as jest.Mock).mockReturnValue(mockLLMClient);

      await expect(generateMindMap(mockTopic)).rejects.toThrow('Mermaid code is empty');
    });

    it('should throw error if response does not start with mindmap', async () => {
      const mockLLMClient = {
        sendTextPrompt: jest.fn().mockResolvedValue(`graph TD
  A --> B`)
      };

      (llmClient.getLLMClient as jest.Mock).mockReturnValue(mockLLMClient);

      await expect(generateMindMap(mockTopic)).rejects.toThrow(
        'Mermaid code must start with "mindmap"'
      );
    });

    it('should throw error if response does not contain root node', async () => {
      const mockLLMClient = {
        sendTextPrompt: jest.fn().mockResolvedValue(`mindmap
  Node1
  Node2`)
      };

      (llmClient.getLLMClient as jest.Mock).mockReturnValue(mockLLMClient);

      await expect(generateMindMap(mockTopic)).rejects.toThrow(
        'Mermaid mind map must contain a root node'
      );
    });

    it('should handle LLM errors', async () => {
      const mockLLMClient = {
        sendTextPrompt: jest.fn().mockRejectedValue(new Error('LLM timeout'))
      };

      (llmClient.getLLMClient as jest.Mock).mockReturnValue(mockLLMClient);

      await expect(generateMindMap(mockTopic)).rejects.toThrow('LLM timeout');
    });

    it('should handle S3 retrieval errors during prompt building', async () => {
      (s3Storage.getExtractedContent as jest.Mock).mockRejectedValue(
        new Error('S3 connection failed')
      );

      const mockLLMClient = {
        sendTextPrompt: jest.fn().mockResolvedValue(`mindmap
  root(Photosynthesis)
    Concept1`)
      };

      (llmClient.getLLMClient as jest.Mock).mockReturnValue(mockLLMClient);

      // Should still generate mind map even if S3 fails
      const result = await generateMindMap(mockTopic);

      expect(result).toContain('mindmap');
      expect(result).toContain('root(Photosynthesis)');
    });
  });
});
