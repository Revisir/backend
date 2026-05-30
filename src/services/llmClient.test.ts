/// <reference types="jest" />
import { LLMClient, getLLMClient, resetLLMClient } from './llmClient.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Mock the Google Generative AI SDK
jest.mock('@google/generative-ai');

describe('LLMClient', () => {
  let mockGenerateContent: jest.Mock;
  let mockGetGenerativeModel: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    resetLLMClient();

    // Setup mock
    mockGenerateContent = jest.fn();
    mockGetGenerativeModel = jest.fn().mockReturnValue({
      generateContent: mockGenerateContent
    });

    (GoogleGenerativeAI as jest.MockedClass<typeof GoogleGenerativeAI>).mockImplementation(() => ({
      getGenerativeModel: mockGetGenerativeModel
    } as any));
  });

  describe('constructor', () => {
    it('should throw error if API key is not provided', () => {
      expect(() => new LLMClient({ apiKey: '' })).toThrow('Gemini API key is required');
    });

    it('should create instance with valid API key', () => {
      const client = new LLMClient({ apiKey: 'test-key' });
      expect(client).toBeInstanceOf(LLMClient);
      expect(GoogleGenerativeAI).toHaveBeenCalledWith('test-key');
    });

    it('should use default model if not specified', () => {
      new LLMClient({ apiKey: 'test-key' });
      expect(mockGetGenerativeModel).toHaveBeenCalledWith({ model: 'gemini-1.5-flash' });
    });

    it('should use custom model if specified', () => {
      new LLMClient({ apiKey: 'test-key', model: 'gemini-pro' });
      expect(mockGetGenerativeModel).toHaveBeenCalledWith({ model: 'gemini-pro' });
    });
  });

  describe('sendTextPrompt', () => {
    it('should send text prompt and return response', async () => {
      const mockResponse = {
        response: {
          text: () => 'Test response'
        }
      };
      mockGenerateContent.mockResolvedValue(mockResponse);

      const client = new LLMClient({ apiKey: 'test-key' });
      const result = await client.sendTextPrompt('Test prompt');

      expect(result).toBe('Test response');
      expect(mockGenerateContent).toHaveBeenCalledWith('Test prompt');
    });

    it('should throw error if response is empty', async () => {
      const mockResponse = {
        response: {
          text: () => ''
        }
      };
      mockGenerateContent.mockResolvedValue(mockResponse);

      const client = new LLMClient({ apiKey: 'test-key' });
      
      await expect(client.sendTextPrompt('Test prompt')).rejects.toThrow(/LLM request failed after 3 attempts.*Empty response from LLM/);
    });

    it('should retry on transient errors', async () => {
      jest.useFakeTimers();
      
      const mockResponse = {
        response: {
          text: () => 'Success after retry'
        }
      };

      mockGenerateContent
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Temporary failure'))
        .mockResolvedValueOnce(mockResponse);

      const client = new LLMClient({ apiKey: 'test-key' });
      const promise = client.sendTextPrompt('Test prompt');

      // Fast-forward through retry delays
      await jest.runAllTimersAsync();

      const result = await promise;
      expect(result).toBe('Success after retry');
      expect(mockGenerateContent).toHaveBeenCalledTimes(3);
      
      jest.useRealTimers();
    }, 10000);

    it('should not retry on authentication errors', async () => {
      mockGenerateContent.mockRejectedValue(new Error('Invalid API key'));

      const client = new LLMClient({ apiKey: 'test-key' });
      
      await expect(client.sendTextPrompt('Test prompt')).rejects.toThrow('Invalid API key');
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('should fail after max retries', async () => {
      mockGenerateContent.mockRejectedValue(new Error('Persistent error'));

      const client = new LLMClient({ apiKey: 'test-key' });
      
      await expect(client.sendTextPrompt('Test prompt')).rejects.toThrow(/LLM request failed after 3 attempts.*Persistent error/);
      expect(mockGenerateContent).toHaveBeenCalledTimes(3);
    });
  });

  describe('sendMultimodalPrompt', () => {
    it('should send text-only multimodal prompt', async () => {
      const mockResponse = {
        response: {
          text: () => 'Multimodal response'
        }
      };
      mockGenerateContent.mockResolvedValue(mockResponse);

      const client = new LLMClient({ apiKey: 'test-key' });
      const result = await client.sendMultimodalPrompt({
        text: 'Describe this'
      });

      expect(result).toBe('Multimodal response');
      expect(mockGenerateContent).toHaveBeenCalledWith([
        { text: 'Describe this' }
      ]);
    });

    it('should send multimodal prompt with images', async () => {
      const mockResponse = {
        response: {
          text: () => 'Image analysis response'
        }
      };
      mockGenerateContent.mockResolvedValue(mockResponse);

      const imageBuffer = Buffer.from('fake-image-data');
      const client = new LLMClient({ apiKey: 'test-key' });
      
      const result = await client.sendMultimodalPrompt({
        text: 'Describe this image',
        images: [imageBuffer],
        mimeTypes: ['image/png']
      });

      expect(result).toBe('Image analysis response');
      expect(mockGenerateContent).toHaveBeenCalledWith([
        { text: 'Describe this image' },
        {
          inlineData: {
            data: imageBuffer.toString('base64'),
            mimeType: 'image/png'
          }
        }
      ]);
    });

    it('should use default mime type if not provided', async () => {
      const mockResponse = {
        response: {
          text: () => 'Response'
        }
      };
      mockGenerateContent.mockResolvedValue(mockResponse);

      const imageBuffer = Buffer.from('fake-image-data');
      const client = new LLMClient({ apiKey: 'test-key' });
      
      await client.sendMultimodalPrompt({
        text: 'Analyze',
        images: [imageBuffer]
      });

      expect(mockGenerateContent).toHaveBeenCalledWith([
        { text: 'Analyze' },
        {
          inlineData: {
            data: imageBuffer.toString('base64'),
            mimeType: 'image/jpeg'
          }
        }
      ]);
    });

    it('should handle multiple images', async () => {
      const mockResponse = {
        response: {
          text: () => 'Multiple images analyzed'
        }
      };
      mockGenerateContent.mockResolvedValue(mockResponse);

      const image1 = Buffer.from('image1');
      const image2 = Buffer.from('image2');
      const client = new LLMClient({ apiKey: 'test-key' });
      
      const result = await client.sendMultimodalPrompt({
        text: 'Compare these images',
        images: [image1, image2],
        mimeTypes: ['image/png', 'image/jpeg']
      });

      expect(result).toBe('Multiple images analyzed');
      expect(mockGenerateContent).toHaveBeenCalledWith([
        { text: 'Compare these images' },
        {
          inlineData: {
            data: image1.toString('base64'),
            mimeType: 'image/png'
          }
        },
        {
          inlineData: {
            data: image2.toString('base64'),
            mimeType: 'image/jpeg'
          }
        }
      ]);
    });

    it('should throw error if multimodal response is empty', async () => {
      const mockResponse = {
        response: {
          text: () => ''
        }
      };
      mockGenerateContent.mockResolvedValue(mockResponse);

      const client = new LLMClient({ apiKey: 'test-key' });
      
      await expect(client.sendMultimodalPrompt({ text: 'Test' })).rejects.toThrow(/LLM request failed after 3 attempts.*Empty response from LLM/);
    });

    it('should retry on transient errors for multimodal prompts', async () => {
      jest.useFakeTimers();
      
      const mockResponse = {
        response: {
          text: () => 'Success'
        }
      };

      mockGenerateContent
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(mockResponse);

      const client = new LLMClient({ apiKey: 'test-key' });
      const promise = client.sendMultimodalPrompt({ text: 'Test' });
      
      // Fast-forward through retry delays
      await jest.runAllTimersAsync();

      const result = await promise;
      expect(result).toBe('Success');
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      
      jest.useRealTimers();
    }, 10000);
  });

  describe('getLLMClient singleton', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...originalEnv };
      resetLLMClient();
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should create singleton instance', () => {
      process.env.GEMINI_API_KEY = 'test-key';
      
      const client1 = getLLMClient();
      const client2 = getLLMClient();

      expect(client1).toBe(client2);
      expect(GoogleGenerativeAI).toHaveBeenCalledTimes(1);
    });

    it('should throw error if GEMINI_API_KEY is not set', () => {
      delete process.env.GEMINI_API_KEY;
      
      expect(() => getLLMClient()).toThrow('GEMINI_API_KEY environment variable is not set');
    });

    it('should create new instance after reset', () => {
      process.env.GEMINI_API_KEY = 'test-key';
      
      const client1 = getLLMClient();
      resetLLMClient();
      const client2 = getLLMClient();

      expect(client1).not.toBe(client2);
      expect(GoogleGenerativeAI).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('should not retry on unauthorized errors', async () => {
      mockGenerateContent.mockRejectedValue(new Error('Unauthorized access'));

      const client = new LLMClient({ apiKey: 'test-key' });
      
      await expect(client.sendTextPrompt('Test')).rejects.toThrow('Unauthorized access');
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('should not retry on forbidden errors', async () => {
      mockGenerateContent.mockRejectedValue(new Error('Forbidden request'));

      const client = new LLMClient({ apiKey: 'test-key' });
      
      await expect(client.sendTextPrompt('Test')).rejects.toThrow('Forbidden request');
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('should not retry on invalid request errors', async () => {
      mockGenerateContent.mockRejectedValue(new Error('Invalid request format'));

      const client = new LLMClient({ apiKey: 'test-key' });
      
      await expect(client.sendTextPrompt('Test')).rejects.toThrow('Invalid request format');
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });
  });
});
