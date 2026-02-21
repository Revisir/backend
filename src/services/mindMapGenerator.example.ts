/**
 * Example usage of Mind Map Generator
 * 
 * This file demonstrates how to use the mind map generation service
 * to create Mermaid mind maps for topics.
 */

import { generateMindMap, buildMindMapPrompt } from './mindMapGenerator';
import { ITopic } from '../models/Topic';

/**
 * Example 1: Generate a mind map for a topic
 */
async function exampleGenerateMindMap() {
  // Mock topic data (in real usage, this would come from MongoDB)
  const topic = {
    topicName: 'Photosynthesis',
    subjectName: 'Biology',
    description: 'The process by which plants convert light energy into chemical energy',
    files: [
      {
        fileName: 'photosynthesis-notes.pdf',
        fileType: 'pdf',
        s3Path: 'topic123/extracted-content-1.md',
        s3Bucket: 'revision-study-content',
        extractedContentUrl: 'https://s3.example.com/topic123/extracted-content-1.md',
        fileUrl: 'https://example.com/file.pdf',
        processedAt: new Date()
      }
    ]
  } as unknown as ITopic;

  try {
    // Generate mind map
    const mermaidCode = await generateMindMap(topic);
    
    console.log('Generated Mermaid Mind Map:');
    console.log(mermaidCode);
    
    // Example output:
    // mindmap
    //   root(Photosynthesis)
    //     Light Reactions
    //       Chlorophyll
    //       ATP Production
    //       NADPH Formation
    //     Calvin Cycle
    //       Carbon Fixation
    //       Sugar Formation
    //       RuBisCO Enzyme
    //     Factors
    //       Light Intensity
    //       CO2 Concentration
    //       Temperature
    
  } catch (error) {
    console.error('Failed to generate mind map:', error);
  }
}

/**
 * Example 2: Build a mind map prompt without generating
 */
async function exampleBuildPrompt() {
  const topic = {
    topicName: 'Machine Learning',
    subjectName: 'Computer Science',
    description: 'Introduction to machine learning algorithms and techniques',
    files: []
  } as unknown as ITopic;

  try {
    // Build the prompt that will be sent to the LLM
    const prompt = await buildMindMapPrompt(topic);
    
    console.log('Mind Map Generation Prompt:');
    console.log(prompt);
    
    // This shows the exact prompt that will be sent to the LLM
    // Useful for debugging or customizing prompts
    
  } catch (error) {
    console.error('Failed to build prompt:', error);
  }
}

/**
 * Example 3: Handle errors gracefully
 */
async function exampleErrorHandling() {
  const topic = {
    topicName: 'Quantum Physics',
    subjectName: 'Physics',
    description: 'Introduction to quantum mechanics',
    files: [
      {
        fileName: 'quantum-notes.pdf',
        fileType: 'pdf',
        s3Path: 'invalid/path.md', // This will fail
        s3Bucket: 'revision-study-content',
        extractedContentUrl: 'https://s3.example.com/invalid/path.md',
        fileUrl: 'https://example.com/file.pdf',
        processedAt: new Date()
      }
    ]
  } as unknown as ITopic;

  try {
    // Even if S3 retrieval fails, the mind map generation continues
    // with [Content unavailable] placeholder
    const mermaidCode = await generateMindMap(topic);
    
    console.log('Generated mind map despite S3 error:');
    console.log(mermaidCode);
    
  } catch (error) {
    // Only LLM errors or validation errors will throw
    console.error('Mind map generation failed:', error);
  }
}

/**
 * Example 4: Validate Mermaid syntax
 */
async function exampleValidation() {
  const topic = {
    topicName: 'Data Structures',
    subjectName: 'Computer Science',
    description: 'Common data structures and their applications',
    files: []
  } as unknown as ITopic;

  try {
    // The generateMindMap function automatically validates:
    // 1. Response is not empty
    // 2. Code starts with 'mindmap'
    // 3. Contains a root node
    const mermaidCode = await generateMindMap(topic);
    
    console.log('Validated Mermaid code:');
    console.log(mermaidCode);
    
  } catch (error) {
    // If validation fails, an error is thrown
    console.error('Validation failed:', error);
  }
}

// Run examples (uncomment to test)
// exampleGenerateMindMap();
// exampleBuildPrompt();
// exampleErrorHandling();
// exampleValidation();
