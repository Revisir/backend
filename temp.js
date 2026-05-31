// To install: npm i @tavily/core
import { tavily } from "@tavily/core";
const client = tavily({ apiKey: "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" });
client
  .extract(["https://www.pmfias.com/humidity-absolute-humidity-relative-humidity-dew-point-specific-humidity-geography-upsc-ias/"], {
    query:
      "Extract the main content from this webpage.\nFocus on the core learning material, excluding navigation and ads.\n\nInclude formulas, diagrams descriptions, and key concepts.\nUse headings, bullet points, and code blocks where appropriate.\n",
    chunksPerSource: 5,
  })
  .then(console.log);
