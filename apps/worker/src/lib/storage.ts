import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createWriteStream, createReadStream } from "fs";
import { stat } from "fs/promises";
import { pipeline } from "stream/promises";
import type { Readable } from "stream";
import { env } from "../env";

const client = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  },
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});

export async function downloadToFile(
  storageKey: string,
  filePath: string,
): Promise<void> {
  const result = await client.send(
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: storageKey }),
  );
  if (!result.Body) throw new Error(`Object ${storageKey} has no body`);
  await pipeline(result.Body as Readable, createWriteStream(filePath));
}

/**
 * Above this a single PUT is risky: S3 caps one at 5 GiB, and a full
 * multi-hour video can pass that. Multipart also means a failure costs
 * one part, not the whole upload.
 */
const MULTIPART_THRESHOLD = 512 * 1024 * 1024;
const PART_SIZE = 64 * 1024 * 1024;

export async function uploadFile(
  filePath: string,
  storageKey: string,
  contentType: string,
): Promise<void> {
  const { size } = await stat(filePath);
  if (size > MULTIPART_THRESHOLD) {
    await uploadMultipart(filePath, storageKey, contentType, size);
    return;
  }
  await client.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: storageKey,
      Body: createReadStream(filePath),
      ContentType: contentType,
      ContentLength: size,
    }),
  );
}

async function uploadMultipart(
  filePath: string,
  storageKey: string,
  contentType: string,
  size: number,
): Promise<void> {
  const target = { Bucket: env.S3_BUCKET, Key: storageKey };
  const { UploadId } = await client.send(
    new CreateMultipartUploadCommand({ ...target, ContentType: contentType }),
  );
  if (!UploadId) throw new Error("Storage did not start the multipart upload");
  try {
    const parts: Array<{ ETag: string | undefined; PartNumber: number }> = [];
    for (let number = 1, offset = 0; offset < size; number++, offset += PART_SIZE) {
      const last = Math.min(size, offset + PART_SIZE) - 1;
      const { ETag } = await client.send(
        new UploadPartCommand({
          ...target,
          UploadId,
          PartNumber: number,
          Body: createReadStream(filePath, { start: offset, end: last }),
          ContentLength: last - offset + 1,
        }),
      );
      parts.push({ ETag, PartNumber: number });
    }
    await client.send(
      new CompleteMultipartUploadCommand({
        ...target,
        UploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
  } catch (err) {
    // Unfinished parts take up space until aborted
    await client
      .send(new AbortMultipartUploadCommand({ ...target, UploadId }))
      .catch(() => undefined);
    throw err;
  }
}

/**
 * Temporary URL ffmpeg can read directly. Lets a job seek into a large
 * object with range requests instead of downloading the whole file.
 * Signed against the internal endpoint — the worker, not a browser.
 */
export async function presignGetUrl(
  storageKey: string,
  expiresIn = 6 * 3600,
): Promise<string> {
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: storageKey }),
    { expiresIn },
  );
}

export async function deleteObject(storageKey: string): Promise<void> {
  await client.send(
    new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: storageKey }),
  );
}
