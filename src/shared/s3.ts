import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';

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

const getClient = (): S3Client => {
  const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID } = process.env;
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ACCOUNT_ID) {
    throw new Error('R2_NOT_CONFIGURED');
  }
  if (!s3Singleton) {
    s3Singleton = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
      // The AWS SDK default is NO timeout. A stalled R2 connection would otherwise hang
      // any awaited upload forever - including the legal snapshot inside the admin's
      // close-campaign request, which must never hang on storage.
      requestHandler: new NodeHttpHandler({ connectionTimeout: 5_000, requestTimeout: 15_000 }),
    });
  }
  return s3Singleton;
};

// Direct server-side upload (no presigning) - used for server-generated artifacts like
// the legal Official Rules snapshot PDFs. Not exposed to user input; callers control the key.
export const uploadObject = async (key: string, body: Buffer, contentType: string): Promise<void> => {
  const { R2_BUCKET } = process.env;
  if (!R2_BUCKET) throw new Error('R2_NOT_CONFIGURED');
  await getClient().send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
};

// Fetch an object's bytes. Returns null on a definite 404; any other failure throws
// (same "could not check is not missing" rule as objectExists).
export const getObject = async (key: string): Promise<Buffer | null> => {
  const { R2_BUCKET } = process.env;
  if (!R2_BUCKET) throw new Error('R2_NOT_CONFIGURED');
  try {
    const res = await getClient().send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    const bytes = await res.Body?.transformToByteArray();
    return bytes ? Buffer.from(bytes) : null;
  } catch (err: unknown) {
    const name = (err as { name?: string })?.name;
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (name === 'NoSuchKey' || name === 'NotFound' || status === 404) return null;
    throw err;
  }
};

// Batch delete (receipt-image purge). S3 DeleteObjects caps at 1000 keys per call, so the
// list is chunked. Returns the keys that are now GONE (deleted or already absent - S3 treats
// deleting a missing key as success, which makes the purge safely re-runnable) and per-key
// failures. Never throws on partial failure: the caller only clears DB references for keys
// in `deleted`, so a failed key stays referenced and a re-run picks it up.
export const deleteObjects = async (
  keys: string[],
): Promise<{ deleted: string[]; failed: Array<{ key: string; message: string }> }> => {
  const { R2_BUCKET } = process.env;
  if (!R2_BUCKET) throw new Error('R2_NOT_CONFIGURED');
  const deleted: string[] = [];
  const failed: Array<{ key: string; message: string }> = [];
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    const res = await getClient().send(new DeleteObjectsCommand({
      Bucket: R2_BUCKET,
      Delete: { Objects: chunk.map((k) => ({ Key: k })), Quiet: false },
    }));
    // Trust ONLY the authoritative res.Deleted list (Quiet: false returns one entry per
    // deleted key). Inferring success as "not in Errors" would silently promote a key from
    // a malformed error entry (no Key field) to "deleted" - and the caller would then clear
    // the DB reference to an object that still exists, unrecoverable by re-run.
    const deletedSet = new Set<string>();
    for (const d of res.Deleted ?? []) {
      if (d.Key) { deletedSet.add(d.Key); deleted.push(d.Key); }
    }
    for (const k of chunk) {
      if (!deletedSet.has(k)) {
        const err = (res.Errors ?? []).find((e) => e.Key === k);
        failed.push({ key: k, message: err?.Message ?? err?.Code ?? 'not confirmed deleted' });
      }
    }
  }
  return { deleted, failed };
};

export const objectExists = async (key: string): Promise<boolean> => {
  const { R2_BUCKET } = process.env;
  if (!R2_BUCKET) throw new Error('R2_NOT_CONFIGURED');
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch (err: unknown) {
    // ONLY a definite 404 means "missing". Any other failure (transient 5xx, network,
    // credentials) must propagate: callers use this to protect archived legal records
    // from overwrite, and "I could not check" must never be read as "safe to overwrite".
    const name = (err as { name?: string })?.name;
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (name === 'NotFound' || name === 'NoSuchKey' || status === 404) return false;
    throw err;
  }
};

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

  const client = getClient();

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
