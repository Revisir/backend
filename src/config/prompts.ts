/**
 * Central configuration for all LLM prompts used across the application.
 */

export const PROMPTS = {
  extraction: {
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
Format the output as structured markdown with headings and lists.
Do not include Social Media, Legal, Contents Menu. Only extract Core information`,

    text: `Format the following text content as structured markdown.
Add appropriate headings, bullet points, and formatting to make it more readable.
Preserve all the original information.`,
  },

  chat: {
    questionExtractor: (studyMaterials: string) =>
      `Extract up to 10 revision questions from the following study material. Each question MUST be directly answerable from the material.

Study Materials:
${studyMaterials}

Respond with ONLY a valid JSON array. No explanation, no markdown fences. Format:
[{"question": "...", "answer": "..."}]

Rules:
- Questions should test key concepts, definitions, facts, and relationships
- Answers must be concise and directly found in the material
- Vary question difficulty (easy to hard)
- Maximum 10 questions`,

    questionReviewer: (questions: string, studyMaterials: string) =>
      `Review the following questions and remove any whose answer is NOT explicitly present in the study material.

Questions:
${questions}

Study Materials:
${studyMaterials}

Return ONLY a valid JSON array of questions that pass review. No explanation, no markdown fences. Format:
[{"question": "...", "answer": "..."}]`,

    answerEvaluator: (question: string, expectedAnswer: string, studentAnswer: string) =>
      `Evaluate the student's answer to this revision question.

Question: ${question}
Expected Answer: ${expectedAnswer}
Student's Answer: ${studentAnswer}

Respond with ONLY valid JSON. No explanation, no markdown fences. Format:
{"correct": true|false, "explanation": "brief feedback to the student"}`,

    assessment: (conversationHistory: string) =>
      `Based on the following conversation, assess the student's understanding of the topic on a 0-5 scale:

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

Provide only the numeric rating (0-5) as a single number.`,
  },

  mindMap: {
    generate: (studyMaterials: string) =>
      `Generate a mind map for the following Material:

${studyMaterials}

Create a comprehensive mind map that:
- Shows the main topic at the center
- Branches out to key concepts and subtopics
- Includes important details and relationships
- Uses clear, concise labels
- In MindElixir format
- Shoul dnot contain any infromation other than the provided Text

Output only the object code, starting with object as the following example
  "{
  nodeData: {
    id: "root",
    topic: "Example Topic",
    root: true,
    children: [
      {"
    ...

Do not include any explanations or additional text, only the MindElixir node object.`,
  },
} as const;
