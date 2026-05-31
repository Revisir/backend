import "dotenv/config";

import { Context } from "aws-lambda";
import mongoose from "mongoose";
import { Topic } from "@models/Topic.js";
import { saveExtractedContentAtPath } from "@services/s3Storage.js";
import { PROMPTS } from "@config/prompts.js";
import { tavily } from "@tavily/core";
import Exa from "exa-js";
import axios from "axios";

export interface UrlProcessorEvent {
  topicId: string;
  userId: string;
  urls: string[];
}

let isConnected = false;

async function connectDB() {
  if (isConnected) return;
  await mongoose.connect(process.env.MONGODB_URI!);
  isConnected = true;
}

const URL_EXTRACTOR = process.env.URL_EXTRACTOR || "jina"; // "tavily" | "jina" | "exa"

async function extractWithTavily(url: string): Promise<string | null> {
  const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY! });
  const response = await tvly.extract([url]);
  const result = response.results?.[0];
  return result?.rawContent || result?.text || null;
}

async function extractWithJina(url: string): Promise<string | null> {
  const response = await axios.get(`https://r.jina.ai/${url}`, {
    headers: {
      Authorization: `Bearer ${process.env.JINA_API_KEY}`,
      "X-Engine": "browser",
      "X-Return-Format": "markdown",
    },
  });
  return response.data || null;
}

async function extractWithExa(url: string): Promise<string | null> {
  const exa = new Exa(process.env.EXA_API_KEY!);
  const result = await exa.getContents([url], {
    summary: { query: PROMPTS.extraction.url },
  });
  return result.results?.[0]?.summary || result.results?.[0]?.text || null;
}

async function extractUrl(url: string): Promise<string | null> {
  try {
    switch (URL_EXTRACTOR) {
      case "tavily":
        return await extractWithTavily(url);
      case "exa":
        return await extractWithExa(url);
      default:
        return await extractWithJina(url);
    }
  } catch (error) {
    console.error(`URL extraction failed for ${url}:`, error);
    return null;
  }
}

async function processUrl(topicId: string, userId: string, url: string) {
  const content = await extractUrl(url);
  if (!content) return;

  const sanitizedName = url.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 100);
  const extractedPath = await saveExtractedContentAtPath(userId, topicId, `url_${sanitizedName}.md`, content);

  await Topic.updateOne(
    { _id: topicId, userId, "urls.url": url },
    {
      $set: {
        "urls.$.extractedContentPath": extractedPath,
        "urls.$.processedAt": new Date(),
      },
    },
  );

  console.log(`URL processed: ${url}`);
}

/**
 * AWS Lambda handler
 */
export const handler = async (event: UrlProcessorEvent, _context?: Context) => {
  console.log("Processing URLs:", JSON.stringify(event));

  const { topicId, userId, urls } = event;
  if (!topicId || !userId || !urls?.length) {
    return { statusCode: 400, body: "Missing required fields" };
  }

  await connectDB();

  for (const url of urls) {
    await processUrl(topicId, userId, url);
  }

  return { statusCode: 200, body: "URL processing complete" };
};
