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
    /** `count` is 10 for the AI chat and larger for question-bank builds. */
    questionExtractor: (studyMaterials: string, count: number) =>
      `Extract up to ${count} revision questions from the following study material. Each question MUST be directly answerable from the material.

Study Materials:
${studyMaterials}

Respond with ONLY a valid JSON array. No explanation, no markdown fences. Format:
[{"question": "...", "answer": "..."}]

Rules:
- Questions should test key concepts, definitions, facts, and relationships
- Answers must be concise and directly found in the material
- Vary question difficulty (easy to hard)
- Maximum ${count} questions`,

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

  questionBank: {
    /**
     * Turns reviewed question-answer pairs into auto-graded items for the
     * normal quiz. `questions` is the reviewed pairs as JSON; `excludedQuestions`
     * is a JSON array of retired question texts the output must not repeat.
     */
    formatter: (questions: string, studyMaterials: string, excludedQuestions: string) =>
      `You are writing auto-graded quiz items for a spaced-repetition study app. Turn the reviewed question-answer pairs below into multiple-choice and fill-in-the-blank items. Every item must be answerable from the study material alone and must have exactly one defensible correct answer.

Reviewed question-answer pairs (JSON):
${questions}

Excluded questions (JSON array of strings, possibly empty). Learners flagged these as bad. Do NOT write any item that asks the same thing as one of them, whether copied, reworded, re-punctuated, or turned into the other item type:
${excludedQuestions}

Study Materials:
${studyMaterials}

Respond with ONLY a valid JSON array. No explanation, no markdown fences, no text before or after the array. Each element has exactly one of these two shapes:
{"type": "mcq", "prompt": "...", "options": ["...", "...", "...", "..."], "answer": "..."}
{"type": "fill_blank", "prompt": "... ____ ...", "answer": "...", "alternatives": ["..."]}

Rules for every item:
- Base every item only on the reviewed pairs and the study material. Never add facts that are not in the material.
- Write at most one item per reviewed pair, and write an item for every pair that can follow these rules.
- Mix both types, roughly half of each. Use "fill_blank" when the answer is a short key term; use "mcq" otherwise.
- Each item must make sense on its own, without the material or the other items.
- If more than one answer could be defended as correct, rewrite the item so only one fits, or leave the item out.

Multiple choice ("mcq"):
- "prompt" is a complete question.
- "options" holds exactly 4 different strings.
- "answer" is copied character for character from one of the 4 options.
- The other 3 options are plausible wrong answers from the same category as the answer (other terms, names, dates, quantities or processes from the same subject), similar in length and form to the answer, and clearly wrong according to the material.
- Never use "All of the above", "None of the above", "Both A and B", or any option that refers to other options.
- Vary which position holds the correct answer.

Fill in the blank ("fill_blank"):
- "prompt" is a declarative sentence, not a question, containing exactly one blank written as four underscores: ____
- The blank replaces a short key term of 1 to 4 words, and that term is the only word or phrase that correctly fills the blank according to the material.
- "answer" is the exact term the blank replaced.
- "alternatives" lists only true synonyms or standard abbreviations of the answer that should also be accepted (for example "DNA" for "deoxyribonucleic acid"). Use [] when there are none. Never list near-misses, broader terms, or narrower terms.
- Do not reveal the answer anywhere else in the sentence.`,
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
