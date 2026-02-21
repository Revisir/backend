/**
 * Example usage of the File Extractor Service
 * 
 * This file demonstrates how to use the file content extraction functionality
 * with different file types (images, PDFs, URLs, and text files).
 */

import { extractContent, extractFromImage, extractFromPDF, extractFromURL, extractFromText } from './fileExtractor';
import * as fs from 'fs';

/**
 * Example 1: Extract content from an image file
 */
async function extractImageExample() {
  console.log('=== Example 1: Extract from Image ===');
  
  // Read an image file (e.g., a screenshot of notes)
  const imageBuffer = fs.readFileSync('./path/to/image.jpg');
  const mimeType = 'image/jpeg';
  
  const result = await extractFromImage(imageBuffer, mimeType);
  
  if (result.success) {
    console.log('Extracted content:');
    console.log(result.content);
  } else {
    console.error('Extraction failed:', result.error);
  }
}

/**
 * Example 2: Extract content from a PDF file
 */
async function extractPDFExample() {
  console.log('=== Example 2: Extract from PDF ===');
  
  // Read a PDF file (e.g., lecture notes)
  const pdfBuffer = fs.readFileSync('./path/to/document.pdf');
  
  const result = await extractFromPDF(pdfBuffer);
  
  if (result.success) {
    console.log('Extracted content:');
    console.log(result.content);
  } else {
    console.error('Extraction failed:', result.error);
  }
}

/**
 * Example 3: Extract content from a URL
 */
async function extractURLExample() {
  console.log('=== Example 3: Extract from URL ===');
  
  const url = 'https://en.wikipedia.org/wiki/Machine_learning';
  
  const result = await extractFromURL(url);
  
  if (result.success) {
    console.log('Extracted content:');
    console.log(result.content);
  } else {
    console.error('Extraction failed:', result.error);
  }
}

/**
 * Example 4: Extract content from a text file
 */
async function extractTextExample() {
  console.log('=== Example 4: Extract from Text File ===');
  
  const textContent = `
    Introduction to Algorithms
    
    An algorithm is a step-by-step procedure for solving a problem.
    Key characteristics:
    - Finite number of steps
    - Well-defined inputs and outputs
    - Deterministic behavior
  `;
  
  const result = await extractFromText(textContent);
  
  if (result.success) {
    console.log('Extracted content:');
    console.log(result.content);
  } else {
    console.error('Extraction failed:', result.error);
  }
}

/**
 * Example 5: Using the unified extractContent function
 */
async function unifiedExtractionExample() {
  console.log('=== Example 5: Unified Extraction ===');
  
  // Extract from an image
  const imageBuffer = fs.readFileSync('./path/to/image.png');
  const imageResult = await extractContent('image', {
    fileBuffer: imageBuffer,
    mimeType: 'image/png'
  });
  console.log('Image extraction:', imageResult.success ? 'Success' : 'Failed');
  
  // Extract from a PDF
  const pdfBuffer = fs.readFileSync('./path/to/document.pdf');
  const pdfResult = await extractContent('pdf', {
    fileBuffer: pdfBuffer
  });
  console.log('PDF extraction:', pdfResult.success ? 'Success' : 'Failed');
  
  // Extract from a URL
  const urlResult = await extractContent('url', {
    url: 'https://example.com/article'
  });
  console.log('URL extraction:', urlResult.success ? 'Success' : 'Failed');
  
  // Extract from text
  const textBuffer = Buffer.from('Some text content');
  const textResult = await extractContent('text', {
    fileBuffer: textBuffer
  });
  console.log('Text extraction:', textResult.success ? 'Success' : 'Failed');
}

/**
 * Example 6: Error handling
 */
async function errorHandlingExample() {
  console.log('=== Example 6: Error Handling ===');
  
  // Try to extract from an invalid URL
  const result = await extractFromURL('https://invalid-url-that-does-not-exist.com');
  
  if (!result.success) {
    console.log('Expected error occurred:');
    console.log('Error message:', result.error);
    console.log('File type:', result.fileType);
    console.log('Content:', result.content); // Will be empty string
  }
}

/**
 * Example 7: Integration with study session creation
 */
async function studySessionIntegrationExample() {
  console.log('=== Example 7: Study Session Integration ===');
  
  // Simulate a user uploading multiple files for a study session
  const files = [
    {
      type: 'image' as const,
      buffer: fs.readFileSync('./path/to/diagram.jpg'),
      mimeType: 'image/jpeg',
      name: 'diagram.jpg'
    },
    {
      type: 'pdf' as const,
      buffer: fs.readFileSync('./path/to/notes.pdf'),
      name: 'notes.pdf'
    },
    {
      type: 'url' as const,
      url: 'https://example.com/reference-article',
      name: 'reference-article'
    }
  ];
  
  // Extract content from all files
  const extractedContents = [];
  
  for (const file of files) {
    console.log(`Processing ${file.name}...`);
    
    let result;
    if (file.type === 'url') {
      result = await extractContent('url', { url: file.url });
    } else if (file.type === 'image') {
      result = await extractContent('image', {
        fileBuffer: file.buffer,
        mimeType: file.mimeType
      });
    } else if (file.type === 'pdf') {
      result = await extractContent('pdf', { fileBuffer: file.buffer });
    }
    
    if (result && result.success) {
      extractedContents.push({
        fileName: file.name,
        fileType: file.type,
        content: result.content
      });
      console.log(`✓ Successfully extracted content from ${file.name}`);
    } else {
      console.log(`✗ Failed to extract content from ${file.name}: ${result?.error}`);
      // Continue with other files even if one fails
    }
  }
  
  console.log(`\nSuccessfully extracted content from ${extractedContents.length}/${files.length} files`);
  
  // Now you would save these extracted contents to S3 and store references in MongoDB
  // For example:
  // - Save to S3: await saveExtractedContent(topicId, extractedContents)
  // - Update MongoDB: await Topic.updateOne({ _id: topicId }, { files: extractedContents })
}

/**
 * Run all examples
 */
async function runAllExamples() {
  try {
    // Note: These examples require actual files and a valid GEMINI_API_KEY
    // Uncomment the examples you want to run
    
    // await extractImageExample();
    // await extractPDFExample();
    // await extractURLExample();
    // await extractTextExample();
    // await unifiedExtractionExample();
    // await errorHandlingExample();
    // await studySessionIntegrationExample();
    
    console.log('Examples completed!');
  } catch (error) {
    console.error('Error running examples:', error);
  }
}

// Uncomment to run examples
// runAllExamples();

export {
  extractImageExample,
  extractPDFExample,
  extractURLExample,
  extractTextExample,
  unifiedExtractionExample,
  errorHandlingExample,
  studySessionIntegrationExample
};
