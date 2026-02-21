import { S3Event, Context } from "aws-lambda";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import mongoose from "mongoose";
import { Topic, IAttachedFile } from "@models/Topic";
import { extractContent, FileType } from "@services/fileExtractor";

const s3Client = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
let isConnected = false;

async function connectDB() {
  if (isConnected) return;
  await mongoose.connect(process.env.MONGODB_URI!);
  isConnected = true;
}

function getFileType(contentType: string): FileType {
  if (contentType.startsWith("image/")) return "image";
  if (contentType === "application/pdf") return "pdf";
  return "text";
}

export const handler = async (event: S3Event, context: Context) => {
  console.log("Processing S3 event:", JSON.stringify(event, null, 2));

  await connectDB();

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    // Parse: {userId}/{topicId}/files/{fileName}
    const pathParts = key.split("/");
    if (pathParts.length !== 4 || pathParts[2] !== "files") {
      console.log(`Skipping invalid path: ${key}`);
      continue;
    }

    const [userId, topicId, , fileName] = pathParts;

    try {
      const getCmd = new GetObjectCommand({ Bucket: bucket, Key: key });
      const response = await s3Client.send(getCmd);
      const fileBuffer = Buffer.from(await response.Body!.transformToByteArray());
      const contentType = response.ContentType || "application/octet-stream";
      const fileType = getFileType(contentType);

      const result = await extractContent(fileType, {
        fileBuffer,
        mimeType: contentType,
      });

      if (!result.success || !result.content) {
        console.error(`Extraction failed for ${key}:`, result.error);
        continue;
      }

      const extractedPath = `${userId}/${topicId}/extracted/${fileName}.md`;
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: extractedPath,
          Body: result.content,
          ContentType: "text/plain",
          Metadata: { userId, topicId, originalFile: fileName },
        }),
      );

      const topic = await Topic.findOne({ _id: topicId, userId });
      if (!topic) {
        console.error(`Topic not found: ${topicId}`);
        continue;
      }

      const fileData: IAttachedFile = {
        fileName,
        fileType,
        // fileUrl: `s3://${bucket}/${key}`,
        s3Path: key,
        s3Bucket: bucket,
        extractedContentUrl: extractedPath,
        processedAt: new Date(),
      };

      topic.files.push(fileData);
      await topic.save();

      console.log(`Successfully processed: ${key}`);
    } catch (error) {
      console.error(`Error processing ${key}:`, error);
    }
  }

  return { statusCode: 200, body: "Processing complete" };
};
