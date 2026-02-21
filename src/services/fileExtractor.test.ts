import {
  extractFromImage,
  extractFromPDF,
  extractFromURL,
  extractFromText,
  extractContent,
  FileType
} from './fileExtractor';
import { getLLMClient, resetLLMClient } from './llmClient';
import axios from 'axios';

// Mock the LLM client
jest.mock('./llmClient');
jest.mock('axios');

const mockGetLLMClient = getLLMClient as jest.MockedFunction<typeof getLLMClient>;
const mockAxios = axios as jest.Mocked<typeof axios>;

// Helper to create mock axios response
function createMockAxiosResponse<T>(data: T): any {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {}
  };
}

describe('File Extractor Service', () => {
  let mockLLMClient: any;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Create mock LLM client
    mockLLMClient = {
      sendTextPrompt: jest.fn(),
      sendMultimodalPrompt: jest.fn()
    };
    
    mockGetLLMClient.mockReturnValue(mockLLMClient);
  });

  afterEach(() => {
    resetLLMClient();
  });

  describe('extractFromImage', () => {
    it('should extract content from an image successfully', async () => {
      const imageBuffer = Buffer.from('fake-image-data');
      const mimeType = 'image/jpeg';
      const expectedContent = '# Extracted Image Content\n\nThis is the extracted text from the image.';

      mockLLMClient.sendMultimodalPrompt.mockResolvedValue(expectedContent);

      const result = await extractFromImage(imageBuffer, mimeType);

      expect(result.success).toBe(true);
      expect(result.content).toBe(expectedContent);
      expect(result.fileType).toBe('image');
      expect(result.error).toBeUndefined();

      expect(mockLLMClient.sendMultimodalPrompt).toHaveBeenCalledWith({
        text: expect.stringContaining('Extract all text and educational content'),
        images: [imageBuffer],
        mimeTypes: [mimeType]
      });
    });

    it('should handle extraction errors gracefully', async () => {
      const imageBuffer = Buffer.from('fake-image-data');
      const mimeType = 'image/png';

      mockLLMClient.sendMultimodalPrompt.mockRejectedValue(
        new Error('LLM service unavailable')
      );

      const result = await extractFromImage(imageBuffer, mimeType);

      expect(result.success).toBe(false);
      expect(result.content).toBe('');
      expect(result.fileType).toBe('image');
      expect(result.error).toContain('Failed to extract content from image');
      expect(result.error).toContain('LLM service unavailable');
    });

    it('should work with different image MIME types', async () => {
      const imageBuffer = Buffer.from('fake-image-data');
      const mimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

      mockLLMClient.sendMultimodalPrompt.mockResolvedValue('Extracted content');

      for (const mimeType of mimeTypes) {
        const result = await extractFromImage(imageBuffer, mimeType);
        
        expect(result.success).toBe(true);
        expect(mockLLMClient.sendMultimodalPrompt).toHaveBeenCalledWith(
          expect.objectContaining({
            mimeTypes: [mimeType]
          })
        );
      }
    });
  });

  describe('extractFromPDF', () => {
    it('should extract content from a PDF successfully', async () => {
      const pdfBuffer = Buffer.from('fake-pdf-data');
      const expectedContent = '# PDF Content\n\n## Key Concepts\n\n- Concept 1\n- Concept 2';

      mockLLMClient.sendMultimodalPrompt.mockResolvedValue(expectedContent);

      const result = await extractFromPDF(pdfBuffer);

      expect(result.success).toBe(true);
      expect(result.content).toBe(expectedContent);
      expect(result.fileType).toBe('pdf');
      expect(result.error).toBeUndefined();

      expect(mockLLMClient.sendMultimodalPrompt).toHaveBeenCalledWith({
        text: expect.stringContaining('Extract the main educational content'),
        images: [pdfBuffer],
        mimeTypes: ['application/pdf']
      });
    });

    it('should handle PDF extraction errors gracefully', async () => {
      const pdfBuffer = Buffer.from('fake-pdf-data');

      mockLLMClient.sendMultimodalPrompt.mockRejectedValue(
        new Error('PDF processing failed')
      );

      const result = await extractFromPDF(pdfBuffer);

      expect(result.success).toBe(false);
      expect(result.content).toBe('');
      expect(result.fileType).toBe('pdf');
      expect(result.error).toContain('Failed to extract content from PDF');
      expect(result.error).toContain('PDF processing failed');
    });
  });

  describe('extractFromURL', () => {
    it('should extract content from a URL successfully', async () => {
      const url = 'https://example.com/article';
      const htmlContent = '<html><body><h1>Article Title</h1><p>Content here</p></body></html>';
      const expectedContent = '# Article Title\n\nContent here';

      mockAxios.get.mockResolvedValue(createMockAxiosResponse(htmlContent));
      mockLLMClient.sendTextPrompt.mockResolvedValue(expectedContent);

      const result = await extractFromURL(url);

      expect(result.success).toBe(true);
      expect(result.content).toBe(expectedContent);
      expect(result.fileType).toBe('url');
      expect(result.error).toBeUndefined();

      expect(mockAxios.get).toHaveBeenCalledWith(url, {
        timeout: 10000,
        headers: {
          'User-Agent': expect.stringContaining('RevisionStudyBot')
        }
      });

      expect(mockLLMClient.sendTextPrompt).toHaveBeenCalledWith(
        expect.stringContaining('Extract the main educational content')
      );
      expect(mockLLMClient.sendTextPrompt).toHaveBeenCalledWith(
        expect.stringContaining(htmlContent)
      );
    });

    it('should handle URL fetch errors gracefully', async () => {
      const url = 'https://example.com/article';

      mockAxios.get.mockRejectedValue(new Error('Network error'));

      const result = await extractFromURL(url);

      expect(result.success).toBe(false);
      expect(result.content).toBe('');
      expect(result.fileType).toBe('url');
      expect(result.error).toContain('Failed to extract content from URL');
      expect(result.error).toContain('Network error');
    });

    it('should handle LLM processing errors for URLs', async () => {
      const url = 'https://example.com/article';
      const htmlContent = '<html><body>Content</body></html>';

      mockAxios.get.mockResolvedValue(createMockAxiosResponse(htmlContent));
      mockLLMClient.sendTextPrompt.mockRejectedValue(
        new Error('LLM timeout')
      );

      const result = await extractFromURL(url);

      expect(result.success).toBe(false);
      expect(result.error).toContain('LLM timeout');
    });
  });

  describe('extractFromText', () => {
    it('should format text content successfully', async () => {
      const textContent = 'This is some plain text content\nwith multiple lines\nand information';
      const expectedContent = '# Formatted Text\n\nThis is some plain text content with multiple lines and information.';

      mockLLMClient.sendTextPrompt.mockResolvedValue(expectedContent);

      const result = await extractFromText(textContent);

      expect(result.success).toBe(true);
      expect(result.content).toBe(expectedContent);
      expect(result.fileType).toBe('text');
      expect(result.error).toBeUndefined();

      expect(mockLLMClient.sendTextPrompt).toHaveBeenCalledWith(
        expect.stringContaining('Format the following text content')
      );
      expect(mockLLMClient.sendTextPrompt).toHaveBeenCalledWith(
        expect.stringContaining(textContent)
      );
    });

    it('should fallback to code block if LLM fails', async () => {
      const textContent = 'Plain text content';

      mockLLMClient.sendTextPrompt.mockRejectedValue(
        new Error('LLM unavailable')
      );

      const result = await extractFromText(textContent);

      expect(result.success).toBe(true);
      expect(result.content).toContain('```');
      expect(result.content).toContain(textContent);
      expect(result.fileType).toBe('text');
    });
  });

  describe('extractContent', () => {
    it('should route to image extractor correctly', async () => {
      const fileBuffer = Buffer.from('image-data');
      const mimeType = 'image/jpeg';
      const expectedContent = 'Extracted image content';

      mockLLMClient.sendMultimodalPrompt.mockResolvedValue(expectedContent);

      const result = await extractContent('image', { fileBuffer, mimeType });

      expect(result.success).toBe(true);
      expect(result.content).toBe(expectedContent);
      expect(result.fileType).toBe('image');
    });

    it('should route to PDF extractor correctly', async () => {
      const fileBuffer = Buffer.from('pdf-data');
      const expectedContent = 'Extracted PDF content';

      mockLLMClient.sendMultimodalPrompt.mockResolvedValue(expectedContent);

      const result = await extractContent('pdf', { fileBuffer });

      expect(result.success).toBe(true);
      expect(result.content).toBe(expectedContent);
      expect(result.fileType).toBe('pdf');
    });

    it('should route to URL extractor correctly', async () => {
      const url = 'https://example.com';
      const expectedContent = 'Extracted URL content';

      mockAxios.get.mockResolvedValue(createMockAxiosResponse('<html>Content</html>'));
      mockLLMClient.sendTextPrompt.mockResolvedValue(expectedContent);

      const result = await extractContent('url', { url });

      expect(result.success).toBe(true);
      expect(result.content).toBe(expectedContent);
      expect(result.fileType).toBe('url');
    });

    it('should route to text extractor correctly', async () => {
      const fileBuffer = Buffer.from('text content');
      const expectedContent = 'Formatted text content';

      mockLLMClient.sendTextPrompt.mockResolvedValue(expectedContent);

      const result = await extractContent('text', { fileBuffer });

      expect(result.success).toBe(true);
      expect(result.content).toBe(expectedContent);
      expect(result.fileType).toBe('text');
    });

    it('should return error for missing image buffer', async () => {
      const result = await extractContent('image', { mimeType: 'image/jpeg' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Image buffer and MIME type are required');
    });

    it('should return error for missing image MIME type', async () => {
      const result = await extractContent('image', { 
        fileBuffer: Buffer.from('data') 
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Image buffer and MIME type are required');
    });

    it('should return error for missing PDF buffer', async () => {
      const result = await extractContent('pdf', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('PDF buffer is required');
    });

    it('should return error for missing URL', async () => {
      const result = await extractContent('url', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('URL is required');
    });

    it('should return error for missing text buffer', async () => {
      const result = await extractContent('text', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Text buffer is required');
    });

    it('should return error for unsupported file type', async () => {
      const result = await extractContent('unsupported' as FileType, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported file type');
    });
  });

  describe('Extraction Prompts', () => {
    it('should use appropriate prompt for images', async () => {
      const imageBuffer = Buffer.from('image-data');
      mockLLMClient.sendMultimodalPrompt.mockResolvedValue('content');

      await extractFromImage(imageBuffer, 'image/jpeg');

      const call = mockLLMClient.sendMultimodalPrompt.mock.calls[0][0];
      expect(call.text).toContain('Extract all text and educational content');
      expect(call.text).toContain('formulas');
      expect(call.text).toContain('diagrams');
      expect(call.text).toContain('markdown');
    });

    it('should use appropriate prompt for PDFs', async () => {
      const pdfBuffer = Buffer.from('pdf-data');
      mockLLMClient.sendMultimodalPrompt.mockResolvedValue('content');

      await extractFromPDF(pdfBuffer);

      const call = mockLLMClient.sendMultimodalPrompt.mock.calls[0][0];
      expect(call.text).toContain('Extract the main educational content');
      expect(call.text).toContain('key concepts');
      expect(call.text).toContain('definitions');
      expect(call.text).toContain('markdown');
    });

    it('should use appropriate prompt for URLs', async () => {
      mockAxios.get.mockResolvedValue(createMockAxiosResponse('<html>Content</html>'));
      mockLLMClient.sendTextPrompt.mockResolvedValue('content');

      await extractFromURL('https://example.com');

      const call = mockLLMClient.sendTextPrompt.mock.calls[0][0];
      expect(call).toContain('Extract the main educational content');
      expect(call).toContain('core learning material');
      expect(call).toContain('excluding navigation and ads');
      expect(call).toContain('markdown');
    });

    it('should use appropriate prompt for text files', async () => {
      mockLLMClient.sendTextPrompt.mockResolvedValue('content');

      await extractFromText('text content');

      const call = mockLLMClient.sendTextPrompt.mock.calls[0][0];
      expect(call).toContain('Format the following text content');
      expect(call).toContain('structured markdown');
      expect(call).toContain('headings');
      expect(call).toContain('bullet points');
    });
  });
});
