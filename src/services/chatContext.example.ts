/**
 * Example usage of Chat Context Builder
 * 
 * This file demonstrates how to use the chat context building functions
 * in a real chat session scenario.
 */

import { buildChatContext, buildAssessmentPrompt, assessStudentPerformance } from './chatContext';
import { Topic } from '../models/Topic';
import { getLLMClient } from './llmClient';

/**
 * Example 1: Building context for a new chat session
 */
async function exampleBuildChatContext() {
  console.log('=== Example 1: Building Chat Context ===\n');

  // Fetch a topic from the database (in real scenario)
  // For this example, we'll assume we have a topic ID
  const topicId = '507f1f77bcf86cd799439011'; // Example MongoDB ObjectId

  try {
    // Fetch the topic document
    const topic = await Topic.findById(topicId);
    
    if (!topic) {
      throw new Error('Topic not found');
    }

    // Build the context prompt
    const contextPrompt = await buildChatContext(topic);
    
    console.log('Context Prompt:');
    console.log(contextPrompt);
    console.log('\n');

    // Send the context to LLM to get initial greeting
    const llmClient = getLLMClient();
    const initialMessage = await llmClient.sendTextPrompt(contextPrompt);
    
    console.log('LLM Initial Greeting:');
    console.log(initialMessage);
    console.log('\n');

    return {
      contextPrompt,
      initialMessage
    };
  } catch (error) {
    console.error('Error building chat context:', error);
    throw error;
  }
}

/**
 * Example 2: Building assessment prompt after a chat session
 */
async function exampleBuildAssessmentPrompt() {
  console.log('=== Example 2: Building Assessment Prompt ===\n');

  // Example conversation history from a chat session
  const conversationMessages = [
    {
      role: 'assistant',
      content: 'Hello! Let\'s review photosynthesis. Can you explain what photosynthesis is?'
    },
    {
      role: 'user',
      content: 'Photosynthesis is the process where plants convert light energy into chemical energy in the form of glucose.'
    },
    {
      role: 'assistant',
      content: 'Excellent! Now, can you tell me what role chlorophyll plays in this process?'
    },
    {
      role: 'user',
      content: 'Chlorophyll is the green pigment in plants that absorbs light energy, particularly red and blue wavelengths.'
    },
    {
      role: 'assistant',
      content: 'Perfect! One more question: what are the main products of photosynthesis?'
    },
    {
      role: 'user',
      content: 'The main products are glucose (sugar) and oxygen gas.'
    }
  ];

  try {
    // Build the assessment prompt
    const assessmentPrompt = buildAssessmentPrompt(conversationMessages);
    
    console.log('Assessment Prompt:');
    console.log(assessmentPrompt);
    console.log('\n');

    // Send to LLM to get quality rating
    const llmClient = getLLMClient();
    const llmRatingResponse = await llmClient.sendTextPrompt(assessmentPrompt);
    
    console.log('LLM Rating Response:');
    console.log(llmRatingResponse);
    console.log('\n');

    // Parse the rating (should be a number 0-5)
    const llmQuality = parseInt(llmRatingResponse.trim());
    
    if (isNaN(llmQuality) || llmQuality < 0 || llmQuality > 5) {
      throw new Error('Invalid LLM quality rating');
    }

    console.log(`Parsed LLM Quality: ${llmQuality}`);
    
    return llmQuality;
  } catch (error) {
    console.error('Error building assessment prompt:', error);
    throw error;
  }
}

/**
 * Example 2b: Using assessStudentPerformance (recommended approach)
 */
async function exampleAssessStudentPerformance() {
  console.log('=== Example 2b: Assess Student Performance (Recommended) ===\n');

  // Example conversation history from a chat session
  const conversationMessages = [
    {
      role: 'assistant',
      content: 'Hello! Let\'s review photosynthesis. Can you explain what photosynthesis is?'
    },
    {
      role: 'user',
      content: 'Photosynthesis is the process where plants convert light energy into chemical energy in the form of glucose.'
    },
    {
      role: 'assistant',
      content: 'Excellent! Now, can you tell me what role chlorophyll plays in this process?'
    },
    {
      role: 'user',
      content: 'Chlorophyll is the green pigment in plants that absorbs light energy, particularly red and blue wavelengths.'
    },
    {
      role: 'assistant',
      content: 'Perfect! One more question: what are the main products of photosynthesis?'
    },
    {
      role: 'user',
      content: 'The main products are glucose (sugar) and oxygen gas.'
    }
  ];

  try {
    // Use the assessStudentPerformance function which handles everything
    console.log('Sending conversation to LLM for assessment...\n');
    
    const llmQuality = await assessStudentPerformance(conversationMessages);
    
    console.log(`LLM Quality Rating: ${llmQuality}`);
    console.log('\n');

    // In a real application, you would also get user self-assessment
    const userQuality = 4; // Example user self-assessment
    const finalQuality = (llmQuality + userQuality) / 2;

    console.log('Final Assessment:');
    console.log(`  User Quality: ${userQuality}`);
    console.log(`  LLM Quality: ${llmQuality}`);
    console.log(`  Final Quality: ${finalQuality}`);
    console.log('\n');
    
    return {
      llmQuality,
      userQuality,
      finalQuality
    };
  } catch (error) {
    console.error('Error assessing student performance:', error);
    throw error;
  }
}

/**
 * Example 3: Complete chat session flow
 */
async function exampleCompleteChatFlow() {
  console.log('=== Example 3: Complete Chat Session Flow ===\n');

  const topicId = '507f1f77bcf86cd799439011';

  try {
    // Step 1: Initialize chat session with context
    const topic = await Topic.findById(topicId);
    if (!topic) {
      throw new Error('Topic not found');
    }

    const contextPrompt = await buildChatContext(topic);
    const llmClient = getLLMClient();
    
    console.log('1. Context built successfully');
    console.log(`   Topic: ${topic.topicName}`);
    console.log(`   Subject: ${topic.subjectName}`);
    console.log(`   Files: ${topic.files.length}`);
    console.log('\n');

    // Step 2: Get initial greeting
    const initialMessage = await llmClient.sendTextPrompt(contextPrompt);
    console.log('2. Initial greeting received from LLM');
    console.log(`   Message: ${initialMessage.substring(0, 100)}...`);
    console.log('\n');

    // Step 3: Simulate conversation (in real app, this would be user interaction)
    const messages = [
      { role: 'assistant', content: initialMessage },
      { role: 'user', content: 'I\'m ready to start!' }
    ];

    console.log('3. Conversation in progress...');
    console.log(`   Messages exchanged: ${messages.length}`);
    console.log('\n');

    // Step 4: Complete session and get assessment
    const assessmentPrompt = buildAssessmentPrompt(messages);
    const llmRatingResponse = await llmClient.sendTextPrompt(assessmentPrompt);
    const llmQuality = parseInt(llmRatingResponse.trim());

    console.log('4. Session completed');
    console.log(`   LLM Quality Rating: ${llmQuality}`);
    console.log('\n');

    // Step 5: Calculate final quality (would include user rating in real app)
    const userQuality = 4; // Example user self-assessment
    const finalQuality = (llmQuality + userQuality) / 2;

    console.log('5. Final assessment');
    console.log(`   User Quality: ${userQuality}`);
    console.log(`   LLM Quality: ${llmQuality}`);
    console.log(`   Final Quality: ${finalQuality}`);
    console.log('\n');

    return {
      topicId,
      finalQuality,
      messageCount: messages.length
    };
  } catch (error) {
    console.error('Error in complete chat flow:', error);
    throw error;
  }
}

/**
 * Example 4: Handling topics with multiple files
 */
async function exampleMultipleFiles() {
  console.log('=== Example 4: Topic with Multiple Files ===\n');

  const topicId = '507f1f77bcf86cd799439012';

  try {
    const topic = await Topic.findById(topicId);
    if (!topic) {
      throw new Error('Topic not found');
    }

    console.log(`Topic: ${topic.topicName}`);
    console.log(`Files attached: ${topic.files.length}`);
    console.log('\nFiles:');
    topic.files.forEach((file, index) => {
      console.log(`  ${index + 1}. ${file.fileName} (${file.fileType})`);
      console.log(`     S3 Path: ${file.s3Path}`);
    });
    console.log('\n');

    // Build context - will retrieve all files from S3
    const contextPrompt = await buildChatContext(topic);
    
    console.log('Context built successfully');
    console.log(`Context length: ${contextPrompt.length} characters`);
    console.log('\n');

    // Check that all files are included in context
    topic.files.forEach(file => {
      const isIncluded = contextPrompt.includes(file.fileName);
      console.log(`  ${file.fileName}: ${isIncluded ? '✓ Included' : '✗ Missing'}`);
    });

    return contextPrompt;
  } catch (error) {
    console.error('Error handling multiple files:', error);
    throw error;
  }
}

/**
 * Example 5: Handling S3 retrieval failures gracefully
 */
async function exampleGracefulFailure() {
  console.log('=== Example 5: Graceful Handling of S3 Failures ===\n');

  const topicId = '507f1f77bcf86cd799439013';

  try {
    const topic = await Topic.findById(topicId);
    if (!topic) {
      throw new Error('Topic not found');
    }

    console.log(`Topic: ${topic.topicName}`);
    console.log(`Attempting to build context with ${topic.files.length} files`);
    console.log('\n');

    // Build context - will handle S3 failures gracefully
    const contextPrompt = await buildChatContext(topic);
    
    console.log('Context built (with graceful failure handling)');
    
    // Check for unavailable content markers
    const hasUnavailableContent = contextPrompt.includes('[Content unavailable]');
    if (hasUnavailableContent) {
      console.log('⚠ Some content was unavailable but session can continue');
    } else {
      console.log('✓ All content retrieved successfully');
    }
    console.log('\n');

    return contextPrompt;
  } catch (error) {
    console.error('Error in graceful failure example:', error);
    throw error;
  }
}

// Export examples for use in other files or testing
export {
  exampleBuildChatContext,
  exampleBuildAssessmentPrompt,
  exampleAssessStudentPerformance,
  exampleCompleteChatFlow,
  exampleMultipleFiles,
  exampleGracefulFailure
};

// Run examples if this file is executed directly
if (require.main === module) {
  (async () => {
    try {
      console.log('Running Chat Context Builder Examples\n');
      console.log('=' .repeat(60));
      console.log('\n');

      // Note: These examples require a running MongoDB instance
      // and valid topic data. Uncomment to run:

      // await exampleBuildChatContext();
      // await exampleBuildAssessmentPrompt();
      // await exampleAssessStudentPerformance();
      // await exampleCompleteChatFlow();
      // await exampleMultipleFiles();
      // await exampleGracefulFailure();

      console.log('Examples completed successfully!');
    } catch (error) {
      console.error('Error running examples:', error);
      process.exit(1);
    }
  })();
}
