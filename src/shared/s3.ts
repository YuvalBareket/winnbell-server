import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Cloudflare R2 is S3-compatible — only difference is the endpoint and public URL format.
// Required env vars:
//   R2_ACCESS_KEY_ID       — R2 API token Access Key ID
//   R2_SECRET_ACCESS_KEY   — R2 API token Secret Access Key
//   R2_ACCOUNT_ID          — Cloudflare Account ID
//   R2_BUCKET              — R2 bucket name
//   R2_PUBLIC_URL          — Public bucket URL (e.g. https://pub-xxx.r2.dev or custom domain)

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
// Hard server-side cap. Client-side compression produces files well under this.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
let s3Singleton: S3Client | null = null;

export const getPresignedUploadUrl = async (
  contentType: string,
  folder: string = 'business-logos',
  contentLength?: number,
): Promise<{ uploadUrl: string; key: string }> => {
  const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID, R2_BUCKET } = process.env;

  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ACCOUNT_ID || !R2_BUCKET) {
    throw new Error('R2_NOT_CONFIGURED');
  }

  if (!ALLOWED_TYPES.includes(contentType)) {
    throw new Error('INVALID_CONTENT_TYPE');
  }

  // Size is signed into the URL — a PUT with a different Content-Length fails
  // the signature at R2, so the cap cannot be bypassed after presigning.
  if (
    contentLength === undefined ||
    !Number.isInteger(contentLength) ||
    contentLength < 1 ||
    contentLength > MAX_UPLOAD_BYTES
  ) {
    throw new Error('INVALID_CONTENT_LENGTH');
  }

  if (!s3Singleton) {
    s3Singleton = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });
  }
  const client = s3Singleton;

  const ext = contentType.split('/')[1];
  const filename = `${crypto.randomUUID()}.${ext}`;
  const key = `${folder}/${filename}`;

  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ContentType: contentType,
    ContentLength: contentLength,
  });

  const uploadUrl = await getSignedUrl(client, command, { expiresIn: 300 });

  return { uploadUrl, key: filename };
};
