import { getLLMClient } from './llmClient';
import axios from 'axios';

/**
 * File Content Extractor Service
 * Extracts educational content from images, PDFs, and URLs using LLM
 */

export type FileType = 'image' | 'pdf' | 'url' | 'text';

interface ExtractionResult {
  content: string;
  fileType: FileType;
  success: boolean;
  error?: string;
}

/**
 * Extraction prompt templates for different file types
 */
const EXTRACTION_PROMPTS = {
  image: `Extract all text and educational content from this image.
Include formulas, diagrams descriptions, and key concepts.
Format the output as clear, structured markdown text.
Use headings, bullet points, and code blocks where appropriate.`,

  pdf: `Extract the main educational content from this PDF.
Focus on key concepts, definitions, formulas, and important points.
Organize the content with clear headings and structure using markdown.
Use bullet points, numbered lists, and code blocks where appropriate.`,

  url: `Extract the main educational content from this webpage.
Focus on the core learning material, excluding navigation and ads.
Summarize key points and important information.
Format the output as structured markdown with headings and lists.`
};

/**
 * Process an image file and extract content using LLM
 * @param imageBuffer - The image file as a Buffer
 * @param mimeType - The MIME type of the image (e.g., 'image/jpeg', 'image/png')
 * @returns Extracted content as markdown text
 */
export async function extractFromImage(
  imageBuffer: Buffer,
  mimeType: string
): Promise<ExtractionResult> {
  try {
    const llmClient = getLLMClient();
    
    const content = await llmClient.sendMultimodalPrompt({
      text: EXTRACTION_PROMPTS.image,
      images: [imageBuffer],
      mimeTypes: [mimeType]
    });

    return {
      content,
      fileType: 'image',
      success: true
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: '',
      fileType: 'image',
      success: false,
      error: `Failed to extract content from image: ${errorMessage}`
    };
  }
}

/**
 * Process a PDF file and extract content using LLM
 * @param pdfBuffer - The PDF file as a Buffer
 * @returns Extracted content as markdown text
 */
export async function extractFromPDF(
  pdfBuffer: Buffer
): Promise<ExtractionResult> {
  try {
    const llmClient = getLLMClient();
    
    // Gemini supports PDF files as inline data
    const content = await llmClient.sendMultimodalPrompt({
      text: EXTRACTION_PROMPTS.pdf,
      images: [pdfBuffer],
      mimeTypes: ['application/pdf']
    });

    return {
      content,
      fileType: 'pdf',
      success: true
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: '',
      fileType: 'pdf',
      success: false,
      error: `Failed to extract content from PDF: ${errorMessage}`
    };
  }
}

/**
 * Process a URL and extract content using LLM
 * @param url - The URL to extract content from
 * @returns Extracted content as markdown text
 */
export async function extractFromURL(
  url: string
): Promise<ExtractionResult> {
  try {
    // First, fetch the webpage content
    const response = await axios.get(url, {
      timeout: 10000, // 10 second timeout
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RevisionStudyBot/1.0)'
      }
    });

    const htmlContent = response.data;
    
    // Send the HTML content to LLM for extraction
    const llmClient = getLLMClient();
    const prompt = `${EXTRACTION_PROMPTS.url}

HTML Content:
${htmlContent}`;

    const content = await llmClient.sendTextPrompt(prompt);

    return {
      content,
      fileType: 'url',
      success: true
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: '',
      fileType: 'url',
      success: false,
      error: `Failed to extract content from URL: ${errorMessage}`
    };
  }
}

/**
 * Process a text file and extract content (minimal processing)
 * @param textContent - The text file content as a string
 * @returns Extracted content as markdown text
 */
export async function extractFromText(
  textContent: string
): Promise<ExtractionResult> {
  try {
    // For text files, we can optionally format them with LLM
    // or just return them as-is wrapped in markdown code block
    const llmClient = getLLMClient();
    const prompt = `Format the following text content as structured markdown.
Add appropriate headings, bullet points, and formatting to make it more readable.
Preserve all the original information.

Text Content:
${textContent}`;

    const content = await llmClient.sendTextPrompt(prompt);

    return {
      content,
      fileType: 'text',
      success: true
    };
  } catch (error) {
    // If LLM fails, return the original text wrapped in markdown
    return {
      content: `\`\`\`\n${textContent}\n\`\`\``,
      fileType: 'text',
      success: true
    };
  }
}

/**
 * Main extraction function that routes to the appropriate extractor
 * @param fileBuffer - The file as a Buffer (for images, PDFs, text)
 * @param fileType - The type of file to process
 * @param mimeType - The MIME type (for images)
 * @param url - The URL (for URL type)
 * @returns Extracted content as markdown text
 */
export async function extractContent(
  fileType: FileType,
  options: {
    fileBuffer?: Buffer;
    mimeType?: string;
    url?: string;
  }
): Promise<ExtractionResult> {
  switch (fileType) {
    case 'image':
      if (!options.fileBuffer || !options.mimeType) {
        return {
          content: '',
          fileType: 'image',
          success: false,
          error: 'Image buffer and MIME type are required'
        };
      }
      return extractFromImage(options.fileBuffer, options.mimeType);

    case 'pdf':
      if (!options.fileBuffer) {
        return {
          content: '',
          fileType: 'pdf',
          success: false,
          error: 'PDF buffer is required'
        };
      }
      return extractFromPDF(options.fileBuffer);

    case 'url':
      if (!options.url) {
        return {
          content: '',
          fileType: 'url',
          success: false,
          error: 'URL is required'
        };
      }
      return extractFromURL(options.url);

    case 'text':
      if (!options.fileBuffer) {
        return {
          content: '',
          fileType: 'text',
          success: false,
          error: 'Text buffer is required'
        };
      }
      return extractFromText(options.fileBuffer.toString('utf-8'));

    default:
      return {
        content: '',
        fileType,
        success: false,
        error: `Unsupported file type: ${fileType}`
      };
  }
}
