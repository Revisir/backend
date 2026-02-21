import { buildChatContext, buildAssessmentPrompt, assessStudentPerformance } from './chatContext';
import { ITopic } from '../models/Topic';
import * as s3Storage from './s3Storage';
import * as llmClient from './llmClient';
import { Types } from 'mongoose';

// Mock the s3Storage and llmClient modules
jest.mock('./s3Storage');
jest.mock('./llmClient');

describe('Chat Context Builder', () => {
  describe('buildChatContext', () => {
    const mockTopic: ITopic = {
      _id: new Types.ObjectId(),
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
          fileName: 'photosynthesis-notes.pdf',
          fileType: 'pdf',
          fileUrl: 'https://example.com/file1.pdf',
          s3Path: 'topic123/extracted-content.md',
          s3Bucket: 'revision-study-content',
          extractedContentUrl: 'https://s3.example.com/topic123/extracted-content.md',
          processedAt: new Date('2024-01-15')
        }
      ],
      mindMap: null,
      mindMapGeneratedAt: null,
      createdAt: new Date('2024-01-15'),
      updatedAt: new Date('2024-01-15'),
      isDue: false
    } as ITopic;

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should build context with topic information and extracted content', async () => {
      const mockContent = '# Photosynthesis\n\nPhotosynthesis is the process...';
      (s3Storage.getExtractedContent as jest.Mock).mockResolvedValue(mockContent);

      const context = await buildChatContext(mockTopic);

      expect(context).toContain('Topic: Photosynthesis');
      expect(context).toContain('Subject: Biology');
      expect(context).toContain('Description: The process by which plants convert light energy into chemical energy');
      expect(context).toContain('### photosynthesis-notes.pdf');
      expect(context).toContain(mockContent);
      expect(context).toContain('You are a helpful tutor');
      expect(context).toContain('Your role:');
      expect(context).toContain('Ask questions to test understanding');
    });

    it('should handle topics with no description', async () => {
      const topicNoDesc: Partial<ITopic> = { ...mockTopic, description: '' };
      (s3Storage.getExtractedContent as jest.Mock).mockResolvedValue('Content here');

      const context = await buildChatContext(topicNoDesc as ITopic);

      expect(context).toContain('Description: [No description provided]');
    });

    it('should handle topics with no files', async () => {
      const topicNoFiles: Partial<ITopic> = { ...mockTopic, files: [] };

      const context = await buildChatContext(topicNoFiles as ITopic);

      expect(context).toContain('[No study materials attached]');
      expect(s3Storage.getExtractedContent).not.toHaveBeenCalled();
    });

    it('should handle multiple files', async () => {
      const topicMultiFiles: ITopic = {
        ...mockTopic,
        files: [
          {
            fileName: 'file1.pdf',
            fileType: 'pdf',
            fileUrl: 'https://example.com/file1.pdf',
            s3Path: 'topic123/file1.md',
            s3Bucket: 'revision-study-content',
            extractedContentUrl: 'https://s3.example.com/topic123/file1.md',
            processedAt: new Date()
          },
          {
            fileName: 'file2.jpg',
            fileType: 'image',
            fileUrl: 'https://example.com/file2.jpg',
            s3Path: 'topic123/file2.md',
            s3Bucket: 'revision-study-content',
            extractedContentUrl: 'https://s3.example.com/topic123/file2.md',
            processedAt: new Date()
          }
        ]
      } as ITopic;

      (s3Storage.getExtractedContent as jest.Mock)
        .mockResolvedValueOnce('Content from file 1')
        .mockResolvedValueOnce('Content from file 2');

      const context = await buildChatContext(topicMultiFiles);

      expect(context).toContain('### file1.pdf');
      expect(context).toContain('Content from file 1');
      expect(context).toContain('### file2.jpg');
      expect(context).toContain('Content from file 2');
      expect(s3Storage.getExtractedContent).toHaveBeenCalledTimes(2);
    });

    it('should continue with other files if one S3 retrieval fails', async () => {
      const topicMultiFiles: ITopic = {
        ...mockTopic,
        files: [
          {
            fileName: 'file1.pdf',
            fileType: 'pdf',
            fileUrl: 'https://example.com/file1.pdf',
            s3Path: 'topic123/file1.md',
            s3Bucket: 'revision-study-content',
            extractedContentUrl: 'https://s3.example.com/topic123/file1.md',
            processedAt: new Date()
          },
          {
            fileName: 'file2.jpg',
            fileType: 'image',
            fileUrl: 'https://example.com/file2.jpg',
            s3Path: 'topic123/file2.md',
            s3Bucket: 'revision-study-content',
            extractedContentUrl: 'https://s3.example.com/topic123/file2.md',
            processedAt: new Date()
          }
        ]
      } as ITopic;

      (s3Storage.getExtractedContent as jest.Mock)
        .mockRejectedValueOnce(new Error('S3 error'))
        .mockResolvedValueOnce('Content from file 2');

      const context = await buildChatContext(topicMultiFiles);

      expect(context).toContain('### file1.pdf');
      expect(context).toContain('[Content unavailable]');
      expect(context).toContain('### file2.jpg');
      expect(context).toContain('Content from file 2');
    });

    it('should include system instructions for tutor role', async () => {
      (s3Storage.getExtractedContent as jest.Mock).mockResolvedValue('Content');

      const context = await buildChatContext(mockTopic);

      expect(context).toContain('You are a helpful tutor assisting a student with revision');
      expect(context).toContain('Ask questions to test understanding');
      expect(context).toContain('Provide explanations when needed');
      expect(context).toContain('Encourage active recall');
      expect(context).toContain('Give constructive feedback');
      expect(context).toContain('Start by greeting the student and asking an opening question');
    });

    it('should format context with proper structure', async () => {
      (s3Storage.getExtractedContent as jest.Mock).mockResolvedValue('Content');

      const context = await buildChatContext(mockTopic);

      // Check that all major sections are present
      expect(context).toMatch(/Topic:.*\nSubject:.*\nDescription:/s);
      expect(context).toContain('Study Materials:');
      expect(context).toContain('Your role:');
    });
  });

  describe('buildAssessmentPrompt', () => {
    it('should build assessment prompt with conversation history', () => {
      const messages = [
        { role: 'assistant', content: 'Hello! Let\'s discuss photosynthesis.' },
        { role: 'user', content: 'Photosynthesis converts light to chemical energy.' },
        { role: 'assistant', content: 'Correct! Can you explain the role of chlorophyll?' },
        { role: 'user', content: 'Chlorophyll absorbs light energy.' }
      ];

      const prompt = buildAssessmentPrompt(messages);

      expect(prompt).toContain('assess the student\'s understanding');
      expect(prompt).toContain('0-5 scale');
      expect(prompt).toContain('Tutor: Hello! Let\'s discuss photosynthesis.');
      expect(prompt).toContain('Student: Photosynthesis converts light to chemical energy.');
      expect(prompt).toContain('Tutor: Correct! Can you explain the role of chlorophyll?');
      expect(prompt).toContain('Student: Chlorophyll absorbs light energy.');
    });

    it('should include rating scale in assessment prompt', () => {
      const messages = [
        { role: 'user', content: 'Test message' }
      ];

      const prompt = buildAssessmentPrompt(messages);

      expect(prompt).toContain('5 - Perfect understanding');
      expect(prompt).toContain('4 - Good understanding');
      expect(prompt).toContain('3 - Adequate understanding');
      expect(prompt).toContain('2 - Poor understanding');
      expect(prompt).toContain('1 - Very poor understanding');
      expect(prompt).toContain('0 - No understanding demonstrated');
    });

    it('should include evaluation criteria', () => {
      const messages = [
        { role: 'user', content: 'Test message' }
      ];

      const prompt = buildAssessmentPrompt(messages);

      expect(prompt).toContain('Consider:');
      expect(prompt).toContain('Accuracy of responses');
      expect(prompt).toContain('Depth of understanding');
      expect(prompt).toContain('Ability to explain concepts');
      expect(prompt).toContain('Speed of recall');
    });

    it('should request numeric rating only', () => {
      const messages = [
        { role: 'user', content: 'Test message' }
      ];

      const prompt = buildAssessmentPrompt(messages);

      expect(prompt).toContain('Provide only the numeric rating (0-5) as a single number');
    });

    it('should handle empty conversation', () => {
      const messages: { role: string; content: string }[] = [];

      const prompt = buildAssessmentPrompt(messages);

      expect(prompt).toContain('assess the student\'s understanding');
      expect(prompt).toContain('0-5 scale');
    });

    it('should format conversation with proper labels', () => {
      const messages = [
        { role: 'assistant', content: 'Question from tutor' },
        { role: 'user', content: 'Answer from student' }
      ];

      const prompt = buildAssessmentPrompt(messages);

      expect(prompt).toContain('Tutor: Question from tutor');
      expect(prompt).toContain('Student: Answer from student');
    });
  });

  describe('assessStudentPerformance', () => {
    const mockMessages = [
      { role: 'assistant', content: 'What is photosynthesis?' },
      { role: 'user', content: 'It\'s how plants make food from sunlight.' },
      { role: 'assistant', content: 'Good! What role does chlorophyll play?' },
      { role: 'user', content: 'It absorbs light energy.' }
    ];

    let mockLLMClient: any;

    beforeEach(() => {
      jest.clearAllMocks();
      mockLLMClient = {
        sendTextPrompt: jest.fn()
      };
      (llmClient.getLLMClient as jest.Mock).mockReturnValue(mockLLMClient);
    });

    it('should send assessment prompt to LLM and return parsed rating', async () => {
      mockLLMClient.sendTextPrompt.mockResolvedValue('4');

      const rating = await assessStudentPerformance(mockMessages);

      expect(rating).toBe(4);
      expect(mockLLMClient.sendTextPrompt).toHaveBeenCalledTimes(1);
      expect(mockLLMClient.sendTextPrompt).toHaveBeenCalledWith(
        expect.stringContaining('assess the student\'s understanding')
      );
    });

    it('should parse rating from response with just a number', async () => {
      mockLLMClient.sendTextPrompt.mockResolvedValue('5');

      const rating = await assessStudentPerformance(mockMessages);

      expect(rating).toBe(5);
    });

    it('should parse rating from response with "rating:" prefix', async () => {
      mockLLMClient.sendTextPrompt.mockResolvedValue('rating: 3');

      const rating = await assessStudentPerformance(mockMessages);

      expect(rating).toBe(3);
    });

    it('should parse rating from response with "score:" prefix', async () => {
      mockLLMClient.sendTextPrompt.mockResolvedValue('score: 2');

      const rating = await assessStudentPerformance(mockMessages);

      expect(rating).toBe(2);
    });

    it('should parse rating from response with additional text', async () => {
      mockLLMClient.sendTextPrompt.mockResolvedValue('Based on the conversation, I would rate the student a 4 out of 5.');

      const rating = await assessStudentPerformance(mockMessages);

      expect(rating).toBe(4);
    });

    it('should handle rating at the start of response', async () => {
      mockLLMClient.sendTextPrompt.mockResolvedValue('5 - The student demonstrated perfect understanding');

      const rating = await assessStudentPerformance(mockMessages);

      expect(rating).toBe(5);
    });

    it('should handle rating at the end of response', async () => {
      mockLLMClient.sendTextPrompt.mockResolvedValue('The student showed good understanding: 4');

      const rating = await assessStudentPerformance(mockMessages);

      expect(rating).toBe(4);
    });

    it('should handle rating of 0', async () => {
      mockLLMClient.sendTextPrompt.mockResolvedValue('0');

      const rating = await assessStudentPerformance(mockMessages);

      expect(rating).toBe(0);
    });

    it('should throw error if no valid rating found', async () => {
      mockLLMClient.sendTextPrompt.mockResolvedValue('The student did well');

      await expect(assessStudentPerformance(mockMessages)).rejects.toThrow(
        'Failed to parse quality rating from LLM response'
      );
    });

    it('should throw error if rating is out of range', async () => {
      mockLLMClient.sendTextPrompt.mockResolvedValue('7');

      await expect(assessStudentPerformance(mockMessages)).rejects.toThrow(
        'Failed to parse quality rating from LLM response'
      );
    });

    it('should throw error if LLM returns empty response', async () => {
      mockLLMClient.sendTextPrompt.mockResolvedValue('');

      await expect(assessStudentPerformance(mockMessages)).rejects.toThrow(
        'Failed to parse quality rating from LLM response'
      );
    });

    it('should handle whitespace in response', async () => {
      mockLLMClient.sendTextPrompt.mockResolvedValue('  3  ');

      const rating = await assessStudentPerformance(mockMessages);

      expect(rating).toBe(3);
    });

    it('should handle uppercase text in response', async () => {
      mockLLMClient.sendTextPrompt.mockResolvedValue('RATING: 4');

      const rating = await assessStudentPerformance(mockMessages);

      expect(rating).toBe(4);
    });

    it('should propagate LLM client errors', async () => {
      mockLLMClient.sendTextPrompt.mockRejectedValue(new Error('LLM API timeout'));

      await expect(assessStudentPerformance(mockMessages)).rejects.toThrow('LLM API timeout');
    });

    it('should handle empty message array', async () => {
      mockLLMClient.sendTextPrompt.mockResolvedValue('3');

      const rating = await assessStudentPerformance([]);

      expect(rating).toBe(3);
      expect(mockLLMClient.sendTextPrompt).toHaveBeenCalledTimes(1);
    });
  });
});
