import { DeleteObjectsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { readFile, unlink } from 'node:fs/promises';

const YEAR_IN_SECONDS = 60 * 60 * 24 * 365;
let client = null;

function withoutTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function r2Config() {
  const config = {
    endpoint: withoutTrailingSlash(process.env.R2_ENDPOINT),
    bucket: String(process.env.R2_BUCKET || '').trim(),
    accessKeyId: String(process.env.R2_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: String(process.env.R2_SECRET_ACCESS_KEY || '').trim(),
    publicBaseUrl: withoutTrailingSlash(process.env.R2_PUBLIC_BASE_URL),
  };
  const values = Object.values(config);
  const supplied = values.filter(Boolean).length;
  if (supplied === 0) return null;
  const missing = Object.entries(config).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) {
    throw new Error(`Cấu hình R2 chưa đầy đủ. Thiếu: ${missing.join(', ')}.`);
  }
  return config;
}

function getClient(config) {
  if (client) return client;
  client = new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return client;
}

function normalizedObjectKey(key) {
  const normalized = String(key || '').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('R2 object key không hợp lệ.');
  }
  return normalized;
}

export function isR2Configured() {
  return Boolean(r2Config());
}

export function r2ObjectUrl(key) {
  const config = r2Config();
  if (!config) return '';
  return `${config.publicBaseUrl}/${normalizedObjectKey(key)}`;
}

/**
 * Uploads a file already processed on the VPS. If R2 is not configured this
 * intentionally returns the existing local URL, keeping local development
 * usable. Once all R2 variables exist, the local file is removed on either
 * upload success or failure so production never retains media indefinitely.
 */
export async function storeProcessedFile({ localPath, localUrl, objectKey, contentType, cacheControl }) {
  const config = r2Config();
  if (!config) return localUrl;

  const key = normalizedObjectKey(objectKey);
  try {
    const body = await readFile(localPath);
    await getClient(config).send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
      CacheControl: cacheControl || `public, max-age=${YEAR_IN_SECONDS}, immutable`,
    }));
    return r2ObjectUrl(key);
  } finally {
    await unlink(localPath).catch(() => undefined);
  }
}

function keyForManagedUrl(value, config) {
  if (typeof value !== 'string' || !value) return '';
  let base;
  let target;
  try {
    base = new URL(`${config.publicBaseUrl}/`);
    target = new URL(value);
  } catch {
    return '';
  }
  if (target.origin !== base.origin) return '';
  const basePath = base.pathname;
  if (!target.pathname.startsWith(basePath)) return '';
  const key = decodeURIComponent(target.pathname.slice(basePath.length)).replace(/^\/+/, '');
  try {
    return normalizedObjectKey(key);
  } catch {
    return '';
  }
}

/**
 * Removes every managed R2 object in one request. It returns the original
 * URLs that belonged to R2, so callers can still clean up legacy local files.
 * Errors intentionally bubble up: a caller deleting a post must never report
 * success while leaving an R2 object orphaned.
 */
export async function deleteStoredObjects(values) {
  const config = r2Config();
  if (!config) return new Set();

  const managed = [...new Set(Array.isArray(values) ? values : [values])]
    .filter((value) => typeof value === 'string' && value)
    .map((value) => ({ value, key: keyForManagedUrl(value, config) }))
    .filter((entry) => entry.key);
  if (!managed.length) return new Set();

  const uniqueKeys = [...new Set(managed.map((entry) => entry.key))];
  const result = await getClient(config).send(new DeleteObjectsCommand({
    Bucket: config.bucket,
    Delete: { Objects: uniqueKeys.map((Key) => ({ Key })), Quiet: true },
  }));
  if (result.Errors?.length) {
    const details = result.Errors.map((error) => `${error.Key || 'unknown'} (${error.Code || 'failed'})`).join(', ');
    throw new Error(`R2 khÃ´ng thá»ƒ xÃ³a media: ${details}.`);
  }
  return new Set(managed.map((entry) => entry.value));
}

/** Returns true only when this URL belonged to the configured R2 bucket. */
export async function deleteStoredObject(value) {
  return (await deleteStoredObjects([value])).has(value);
}
