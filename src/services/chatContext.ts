import { ITopic } from '@models/Topic';
import { getExtractedContent } from './s3Storage';
import { getLLMClient } from './llmClient';

/**
 * Chat Context Builder
 * Builds context prompts for LLM-based revision sessions
 */

/**
 * Builds a context prompt for chat-based revision from topic data.
 * Retrieves extracted content from S3 and formats it with topic information.
 * 
 * @param topic - The topic document containing all topic information
 * @returns Formatted context prompt for the LLM
 * @throws Error if S3 content retrieval fails
 */
export async function buildChatContext(topic: ITopic): Promise<string> {
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

  // Build the complete context prompt
  const contextPrompt = `You are a helpful tutor assisting a student with revision.

Topic: ${topic.topicName}
Subject: ${topic.subjectName}
Description: ${topic.description || '[No description provided]'}

Study Materials:
${studyMaterials}

Your role:
- Ask questions to test understanding
- Provide explanations when needed
- Encourage active recall
- Give constructive feedback

Start by greeting the student and asking an opening question about the topic.`;

  return contextPrompt;
}

/**
 * Builds an assessment prompt for the LLM to evaluate student performance.
 * Used at the end of a revision session to get the LLM's quality rating.
 * 
 * @param messages - Array of conversation messages from the chat session
 * @returns Assessment prompt for the LLM
 */
export function buildAssessmentPrompt(messages: { role: string; content: string }[]): string {
  // Format conversation history
  const conversationHistory = messages
    .map(msg => `${msg.role === 'user' ? 'Student' : 'Tutor'}: ${msg.content}`)
    .join('\n\n');

  const assessmentPrompt = `Based on the following conversation, assess the student's understanding of the topic on a 0-5 scale:

${conversationHistory}

Rating Scale:
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

Provide only the numeric rating (0-5) as a single number.`;

  return assessmentPrompt;
}

/**
 * Assesses student performance by sending conversation history to LLM.
 * Parses the LLM response to extract a quality score (0-5).
 * 
 * @param messages - Array of conversation messages from the chat session
 * @returns Quality score from 0-5
 * @throws Error if LLM fails to provide a valid rating
 */
export async function assessStudentPerformance(
  messages: { role: string; content: string }[]
): Promise<number> {
  // Build the assessment prompt
  const assessmentPrompt = buildAssessmentPrompt(messages);

  // Send to LLM
  const llmClient = getLLMClient();
  const response = await llmClient.sendTextPrompt(assessmentPrompt);

  // Parse the response to extract the numeric rating
  const rating = parseQualityRating(response);

  return rating;
}

/**
 * Parses LLM response to extract a quality rating (0-5).
 * Handles various response formats and extracts the numeric value.
 * 
 * @param response - The LLM response text
 * @returns Quality score from 0-5
 * @throws Error if no valid rating found in response
 */
function parseQualityRating(response: string): number {
  // Remove whitespace and convert to lowercase for easier parsing
  const cleanResponse = response.trim().toLowerCase();

  // Try to find a single digit 0-5 in the response
  // Look for patterns like "5", "rating: 4", "score: 3", etc.
  const patterns = [
    /^([0-5])$/,                    // Just the number
    /rating[:\s]+([0-5])/,          // "rating: 4" or "rating 4"
    /score[:\s]+([0-5])/,           // "score: 3" or "score 3"
    /^([0-5])[^0-9]/,               // Number at start followed by non-digit
    /[^0-9]([0-5])$/,               // Number at end preceded by non-digit
    /\b([0-5])\b/,                  // Any single digit 0-5 with word boundaries
  ];

  for (const pattern of patterns) {
    const match = cleanResponse.match(pattern);
    if (match && match[1]) {
      const rating = parseInt(match[1], 10);
      if (rating >= 0 && rating <= 5) {
        return rating;
      }
    }
  }

  // If no valid rating found, throw an error
  throw new Error(
    `Failed to parse quality rating from LLM response: "${response}". Expected a number between 0-5.`
  );
}
