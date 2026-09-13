# Configuration Files

This directory contains configuration files for various services used by the backend.

## S3 Configuration (`s3.ts`)

The S3 configuration provides a unified interface for S3-compatible storage,
switching between AWS S3 and the SeaweedFS S3 gateway based on the `BUCKET_TYPE`
environment variable. `BUCKET_TYPE=seaweedfs` selects SeaweedFS; anything else,
including unset, selects AWS S3. `NODE_ENV` plays no part in this.

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

#### AWS S3
Leave `BUCKET_TYPE` unset (or set it to anything but `seaweedfs`) and configure:
- `AWS_REGION` - AWS region (default: us-east-1)
- `AWS_ACCESS_KEY_ID` - AWS access key
- `AWS_SECRET_ACCESS_KEY` - AWS secret key
- `S3_BUCKET_NAME` - S3 bucket name (default: revision-study-content)

#### SeaweedFS (Local Development)
Set `BUCKET_TYPE=seaweedfs` and configure:
- `S3_ENDPOINT` - S3 gateway host (default: localhost)
- `S3_PORT` - S3 gateway port (default: 8333)
- `S3_USE_SSL` - Use HTTPS (default: false)
- `S3_ACCESS_KEY` - access key (default: seaweedfsadmin)
- `S3_SECRET_KEY` - secret key (default: seaweedfsadmin)
- `S3_BUCKET_NAME` - Bucket name (default: revision-study-content)
- `S3_PUBLIC_URL` - optional browser-facing origin that presigned URLs are rewritten to

The credentials must match an identity in the gateway's own `s3.json`
(`../../../.github/seaweedfs/s3.json` in the compose setup).

Two SeaweedFS quirks the client compensates for:

- **`forcePathStyle: true`** — the gateway does not do virtual-host bucket
  addressing by default.
- **`requestChecksumCalculation: "WHEN_REQUIRED"`** — SeaweedFS reads
  `x-amz-checksum-*` out of the presigned query string and verifies it against the
  uploaded bytes. The SDK default hoists a CRC32 of the *empty* presign body into
  that query, so every presigned upload would fail the check.

A third quirk is compensated for elsewhere: SeaweedFS only stores `x-amz-meta-*`
that arrive as request *headers*, and the presigner hoists them into the query, so
object user metadata does not survive a presigned upload.
`fileProcessor.parseUploadKey` reads the object key instead.

### Setting up SeaweedFS for Local Development

The compose files already do this — `cd ../../../.github/local && docker compose up`
starts an all-in-one `weed server -filer -s3` plus a one-shot init container that
creates the bucket. To run it by hand:

1. Start the gateway:

   ```bash
   docker run -p 8333:8333 -p 8888:8888 -p 9333:9333 \
     -v "$PWD/s3.json:/etc/seaweedfs/s3.json:ro" \
     chrislusf/seaweedfs:latest \
     server -ip=localhost -ip.bind=0.0.0.0 -filer -s3 -s3.config=/etc/seaweedfs/s3.json
   ```

2. Create the bucket (`weed shell` reads commands from stdin):

   ```bash
   echo 's3.bucket.create -name revision-study-content' \
     | docker run -i --rm --network host chrislusf/seaweedfs:latest \
       weed shell -master=localhost:9333 -filer=localhost:8888
   ```

3. Set `BUCKET_TYPE=seaweedfs` in your `.env` — already the default in
   `.env.example`.

### Testing

Run the S3 configuration tests:
```bash
npm test -- s3.test.ts
```

## Database Configuration (`database.ts`)

MongoDB connection configuration using Mongoose.

### Environment Variables
- `MONGODB_URI` - MongoDB connection string (default: mongodb://localhost:27017/revision-study-reminder)
