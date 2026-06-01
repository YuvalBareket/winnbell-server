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
let s3Singleton: S3Client | null = null;

export const getPresignedUploadUrl = async (
  contentType: string,
  folder: string = 'business-logos',
): Promise<{ uploadUrl: string; key: string }> => {
  const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID, R2_BUCKET } = process.env;

  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ACCOUNT_ID || !R2_BUCKET) {
    throw new Error('R2_NOT_CONFIGURED');
  }

  if (!ALLOWED_TYPES.includes(contentType)) {
    throw new Error('INVALID_CONTENT_TYPE');
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
  });

  const uploadUrl = await getSignedUrl(client, command, { expiresIn: 300 });

  return { uploadUrl, key: filename };
};
