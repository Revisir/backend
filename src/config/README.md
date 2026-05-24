# Configuration Files

This directory contains configuration files for various services used by the backend.

## S3 Configuration (`s3.ts`)

The S3 configuration provides a unified interface for S3-compatible storage that automatically switches between AWS S3 (production) and MinIO (local development) based on the `NODE_ENV` environment variable.

### Usage

```typescript
import { s3Client, S3_BUCKET_NAME } from './config/s3';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

// Upload a file
await s3Client.send(new PutObjectCommand({
  Bucket: S3_BUCKET_NAME,
  Key: 'path/to/file.txt',
  Body: 'file content',
  ContentType: 'text/plain'
}));

// Download a file
const response = await s3Client.send(new GetObjectCommand({
  Bucket: S3_BUCKET_NAME,
  Key: 'path/to/file.txt'
}));
```

### Environment Variables

#### Production (AWS S3)
Set `NODE_ENV=production` and configure:
- `AWS_REGION` - AWS region (default: us-east-1)
- `AWS_ACCESS_KEY_ID` - AWS access key
- `AWS_SECRET_ACCESS_KEY` - AWS secret key
- `S3_BUCKET_NAME` - S3 bucket name (default: revision-study-content)

#### Development (MinIO)
Set `NODE_ENV=development` or leave unset, and configure:
- `MINIO_ENDPOINT` - MinIO server endpoint (default: localhost)
- `MINIO_PORT` - MinIO server port (default: 9000)
- `MINIO_USE_SSL` - Use HTTPS for MinIO (default: false)
- `MINIO_ACCESS_KEY` - MinIO access key (default: minioadmin)
- `MINIO_SECRET_KEY` - MinIO secret key (default: minioadmin)
- `S3_BUCKET_NAME` - Bucket name (default: revision-study-content)

### Setting up MinIO for Local Development

1. Install MinIO:
   ```bash
   # Using Docker
   docker run -p 9000:9000 -p 9001:9001 \
     -e "MINIO_ROOT_USER=minioadmin" \
     -e "MINIO_ROOT_PASSWORD=minioadmin" \
     minio/minio server /data --console-address ":9001"
   ```

2. Create the bucket:
   - Open MinIO console at http://localhost:9001
   - Login with minioadmin/minioadmin
   - Create a bucket named `revision-study-content`

3. Update your `.env` file with MinIO settings (already configured by default)

### Testing

Run the S3 configuration tests:
```bash
npm test -- s3.test.ts
```

## Database Configuration (`database.ts`)

MongoDB connection configuration using Mongoose.

### Environment Variables
- `MONGODB_URI` - MongoDB connection string (default: mongodb://localhost:27017/revision-study-reminder)
