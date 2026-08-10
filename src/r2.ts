import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config.js";

function assertR2Configured() {
  if (
    !config.r2.endpoint ||
    !config.r2.accessKeyId ||
    !config.r2.secretAccessKey ||
    !config.r2.bucket
  ) {
    throw new Error("R2 is not configured. Set R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET.");
  }
}

// R2 is S3-compatible. Path-style addressing avoids vhost DNS/cert issues.
export const s3 = new S3Client({
  region: config.r2.region,
  endpoint: config.r2.endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.r2.accessKeyId,
    secretAccessKey: config.r2.secretAccessKey,
  },
});

const PREVIEW_TTL_SECONDS = 60 * 60; // 1 hour

export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  assertR2Configured();
  await s3.send(
    new PutObjectCommand({
      Bucket: config.r2.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/** Short-lived presigned GET URL for previewing/downloading a private object. */
export function presignGet(key: string): Promise<string> {
  assertR2Configured();
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: config.r2.bucket, Key: key }),
    { expiresIn: PREVIEW_TTL_SECONDS },
  );
}

export async function deleteObject(key: string): Promise<void> {
  assertR2Configured();
  await s3.send(
    new DeleteObjectCommand({ Bucket: config.r2.bucket, Key: key }),
  );
}
