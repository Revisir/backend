/**
 * Example usage of the LLM Client
 * 
 * This file demonstrates how to use the LLM client for various tasks
 * in the Revision Study Reminder application.
 */

import { getLLMClient } from './llmClient';
import * as fs from 'fs';

/**
 * Example 1: Extract content from an image
 */
async function extractImageContent() {
  const client = getLLMClient();
  
  // Read image file
  const imageBuffer = fs.readFileSync('path/to/image.jpg');
  
  const prompt = `Extract all text and educational content from this image. 
Include formulas, diagrams descriptions, and key concepts.
Format the output as clear, structured text.`;

  const extractedContent = await client.sendMultimodalPrompt({
    text: prompt,
    images: [imageBuffer],
    mimeTypes: ['image/jpeg']
  });
  
  console.log('Extracted content:', extractedContent);
  return extractedContent;
}

/**
 * Example 2: Extract content from a PDF (as image pages)
 */
async function extractPDFContent() {
  const client = getLLMClient();
  
  // Assuming PDF has been converted to images (one per page)
  const page1Buffer = fs.readFileSync('path/to/pdf-page1.png');
  const page2Buffer = fs.readFileSync('path/to/pdf-page2.png');
  
  const prompt = `Extract the main educational content from this PDF.
Focus on key concepts, definitions, formulas, and important points.
Organize the content with clear headings and structure.`;

  const extractedContent = await client.sendMultimodalPrompt({
    text: prompt,
    images: [page1Buffer, page2Buffer],
    mimeTypes: ['image/png', 'image/png']
  });
  
  console.log('Extracted PDF content:', extractedContent);
  return extractedContent;
}

/**
 * Example 3: Build chat context for revision session
 */
async function buildChatContext(topicName: string, subject: string, description: string, extractedContent: string) {
  const client = getLLMClient();
  
  const contextPrompt = `You are a helpful tutor assisting a student with revision.

Topic: ${topicName}
Subject: ${subject}
Description: ${description}

Study Materials:
${extractedContent}

Your role:
- Ask questions to test understanding
- Provide explanations when needed
- Encourage active recall
- Give constructive feedback

Start by greeting the student and asking an opening question about the topic.`;

  const initialMessage = await client.sendTextPrompt(contextPrompt);
  
  console.log('Initial chat message:', initialMessage);
  return initialMessage;
}

/**
 * Example 4: Send a chat message during revision
 */
async function sendChatMessage(conversationHistory: string, userMessage: string) {
  const client = getLLMClient();
  
  const prompt = `${conversationHistory}

Student: ${userMessage}

Tutor:`;

  const response = await client.sendTextPrompt(prompt);
  
  console.log('Tutor response:', response);
  return response;
}

/**
 * Example 5: Assess student performance
 */
async function assessPerformance(conversationHistory: string) {
  const client = getLLMClient();
  
  const assessmentPrompt = `Based on the conversation, assess the student's understanding of the topic on a 0-5 scale:
5 - Perfect understanding, answered all questions correctly without hesitation
4 - Good understanding, correct answers with minor hesitation
3 - Adequate understanding, correct with some difficulty
2 - Poor understanding, incorrect but showed some knowledge
1 - Very poor understanding, mostly incorrect
0 - No understanding demonstrated

Consider:
- Accuracy of responses
- Depth of understanding
- Ability to explain concepts
- Speed of recall

Conversation:
${conversationHistory}

Provide only the numeric rating (0-5).`;

  const rating = await client.sendTextPrompt(assessmentPrompt);
  
  console.log('LLM assessment:', rating);
  return parseInt(rating.trim());
}

/**
 * Example 6: Generate a mind map
 */
async function generateMindMap(topicName: string, subject: string, description: string, extractedContent: string) {
  const client = getLLMClient();
  
  const mindMapPrompt = `Generate a Mermaid mind map for the following topic:

Topic: ${topicName}
Subject: ${subject}
Description: ${description}

Study Materials:
${extractedContent}

Create a comprehensive mind map that:
- Shows the main topic at the center
- Branches out to key concepts and subtopics
- Includes important details and relationships
- Uses clear, concise labels
- Follows Mermaid mindmap syntax

Output only the Mermaid code, starting with:
mindmap
  root(${topicName})
    ...`;

  const mermaidCode = await client.sendTextPrompt(mindMapPrompt);
  
  console.log('Generated mind map:', mermaidCode);
  return mermaidCode;
}

/**
 * Example 7: Error handling
 */
async function handleErrors() {
  const client = getLLMClient();
  
  try {
    const response = await client.sendTextPrompt('Test prompt');
    console.log('Response:', response);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('timeout')) {
        console.error('Request timed out after 30 seconds');
      } else if (error.message.includes('API key')) {
        console.error('Authentication error - check API key');
      } else if (error.message.includes('failed after')) {
        console.error('Request failed after multiple retries');
      } else {
        console.error('Unexpected error:', error.message);
      }
    }
  }
}

// Export examples for use in other modules
export {
  extractImageContent,
  extractPDFContent,
  buildChatContext,
  sendChatMessage,
  assessPerformance,
  generateMindMap,
  handleErrors
};
