import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
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

export async function uploadFile(
  filePath: string,
  storageKey: string,
  contentType: string,
): Promise<void> {
  const { size } = await stat(filePath);
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

export async function deleteObject(storageKey: string): Promise<void> {
  await client.send(
    new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: storageKey }),
  );
}
