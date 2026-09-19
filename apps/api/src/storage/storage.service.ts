import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import type { PresignedUpload } from "@clipforge/shared-types";

const UPLOAD_URL_TTL_SECONDS = 15 * 60;
const DEFAULT_GET_TTL_SECONDS = 60 * 60;

export interface PresignGetOptions {
  expiresIn?: number;
  /** Forces a download with this file name instead of inline playback. */
  downloadFileName?: string;
}

/**
 * Private S3/MinIO bucket access. The API never streams media itself —
 * browsers read and write objects through short-lived presigned URLs.
 */
@Injectable()
export class StorageService {
  private readonly bucket: string;
  /**
   * Signs URLs against the endpoint the *browser* can reach, which can
   * differ from the internal S3_ENDPOINT (e.g. a Docker hostname).
   * Presigning is offline, so this client never makes network calls.
   */
  private readonly signer: S3Client;

  constructor(config: ConfigService) {
    this.bucket = config.getOrThrow<string>("S3_BUCKET");
    this.signer = new S3Client({
      endpoint:
        config.get<string>("S3_PUBLIC_ENDPOINT") ??
        config.getOrThrow<string>("S3_ENDPOINT"),
      region: config.getOrThrow<string>("S3_REGION"),
      credentials: {
        accessKeyId: config.getOrThrow<string>("S3_ACCESS_KEY"),
        secretAccessKey: config.getOrThrow<string>("S3_SECRET_KEY"),
      },
      forcePathStyle: config.getOrThrow<boolean>("S3_FORCE_PATH_STYLE"),
    });
  }

  /**
   * Presigned PUT for a raw browser upload. Keys live under the caller's
   * prefix, which the import endpoint checks before accepting a key.
   */
  async presignUpload(
    userId: string,
    fileName: string,
    contentType: string,
  ): Promise<PresignedUpload> {
    const storageKey = `users/${userId}/uploads/${randomUUID()}/${safeFileName(fileName)}`;
    // Sign content-type so the browser must PUT with the validated type
    const uploadUrl = await getSignedUrl(
      this.signer,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        ContentType: contentType,
      }),
      {
        expiresIn: UPLOAD_URL_TTL_SECONDS,
        signableHeaders: new Set(["content-type"]),
      },
    );
    return { uploadUrl, storageKey, expiresIn: UPLOAD_URL_TTL_SECONDS };
  }

  async presignGet(
    storageKey: string,
    options: PresignGetOptions = {},
  ): Promise<string> {
    const { expiresIn = DEFAULT_GET_TTL_SECONDS, downloadFileName } = options;
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        ResponseContentDisposition: downloadFileName
          ? `attachment; filename="${safeFileName(downloadFileName)}"`
          : undefined,
      }),
      { expiresIn },
    );
  }
}

/** Strips paths and anything that isn't safe in a key or header value. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(-100);
  return cleaned || "upload";
}
