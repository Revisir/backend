import { ITopic } from '@models/Topic';
import { getExtractedContent } from './s3Storage';
import { getLLMClient } from './llmClient';

/**
 * Mind Map Generator
 * Generates Mermaid mind map diagrams for topics using LLM
 */

/**
 * Builds a prompt for generating a Mermaid mind map from topic data.
 * Retrieves extracted content from S3 and formats it with topic information.
 * 
 * @param topic - The topic document containing all topic information
 * @returns Formatted prompt for mind map generation
 * @throws Error if S3 content retrieval fails
 */
export async function buildMindMapPrompt(topic: ITopic): Promise<string> {
  // Retrieve all extracted content from S3
  const extractedContents: string[] = [];
  
  for (const file of topic.files) {
    try {
      const content = await getExtractedContent(topic.userId, file.s3Path);
      extractedContents.push(`\n### ${file.fileName}\n${content}`);
    } catch (error) {
      console.error(`Failed to retrieve content for file ${file.fileName}:`, error);
      // Continue with other files even if one fails
      extractedContents.push(`\n### ${file.fileName}\n[Content unavailable]`);
    }
  }

  // Combine all extracted content
  const studyMaterials = extractedContents.length > 0
    ? extractedContents.join('\n')
    : '[No study materials attached]';

  // Build the mind map generation prompt
  const mindMapPrompt = `Generate a Mermaid mind map for the following topic:

Topic: ${topic.topicName}
Subject: ${topic.subjectName}
Description: ${topic.description || '[No description provided]'}

Study Materials:
${studyMaterials}

Create a comprehensive mind map that:
- Shows the main topic at the center
- Branches out to key concepts and subtopics
- Includes important details and relationships
- Uses clear, concise labels
- Follows Mermaid mindmap syntax

Output only the Mermaid code, starting with:
mindmap
  root(${topic.topicName})
    ...

Do not include any explanations or additional text, only the Mermaid diagram code.`;

  return mindMapPrompt;
}

/**
 * Generates a Mermaid mind map for a topic using LLM.
 * Retrieves topic content from S3, sends to LLM, and validates the result.
 * 
 * @param topic - The topic document to generate a mind map for
 * @returns Mermaid diagram syntax as a string
 * @throws Error if LLM fails or returns invalid Mermaid syntax
 */
export async function generateMindMap(topic: ITopic): Promise<string> {
  // Build the mind map generation prompt
  const prompt = await buildMindMapPrompt(topic);

  // Send to LLM
  const llmClient = getLLMClient();
  const response = await llmClient.sendTextPrompt(prompt);

  // Extract and validate Mermaid syntax
  const mermaidCode = extractMermaidCode(response);
  validateMermaidSyntax(mermaidCode);

  return mermaidCode;
}

/**
 * Extracts Mermaid code from LLM response.
 * Handles various response formats including code blocks.
 * 
 * @param response - The LLM response text
 * @returns Extracted Mermaid code
 */
function extractMermaidCode(response: string): string {
  // Remove leading/trailing whitespace
  let code = response.trim();

  // Remove markdown code blocks if present
  // Pattern: ```mermaid ... ``` or ``` ... ```
  const codeBlockPattern = /```(?:mermaid)?\s*([\s\S]*?)```/;
  const match = code.match(codeBlockPattern);
  
  if (match && match[1]) {
    code = match[1].trim();
  }

  return code;
}

/**
 * Validates Mermaid mind map syntax.
 * Checks for required elements and basic structure.
 * 
 * @param mermaidCode - The Mermaid code to validate
 * @throws Error if syntax is invalid
 */
function validateMermaidSyntax(mermaidCode: string): void {
  // Check if code is empty
  if (!mermaidCode || mermaidCode.length === 0) {
    throw new Error('Mermaid code is empty');
  }

  // Check if it starts with 'mindmap'
  const lines = mermaidCode.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  
  if (lines.length === 0) {
    throw new Error('Mermaid code contains no content');
  }

  if (!lines[0].toLowerCase().startsWith('mindmap')) {
    throw new Error('Mermaid code must start with "mindmap"');
  }

  // Check if it has a root node
  const hasRoot = lines.some(line => line.includes('root('));
  
  if (!hasRoot) {
    throw new Error('Mermaid mind map must contain a root node');
  }

  // Basic validation passed
}
