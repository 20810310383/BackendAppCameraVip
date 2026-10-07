import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { BUNDLED_APPLE_JWKS } from './apple-jwks-fallback.js';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = `${APPLE_ISSUER}/auth/keys`;
const JWKS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const JWKS_REQUEST_TIMEOUT_MS = 8_000;
const JWKS_REQUEST_RETRY_DELAYS_MS = [0, 300, 1_000];

let cachedRemoteKeys = null;
let cachedRemoteKeysExpiresAt = 0;
let cachedRemoteKeysUpdatedAt = null;

export class AppleIdTokenVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AppleIdTokenVerificationError';
  }
}

export class AppleKeySetUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AppleKeySetUnavailableError';
  }
}

function decodeBase64UrlJson(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new AppleIdTokenVerificationError(`Apple ID token ${label} không hợp lệ.`);
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid JSON object.');
    return parsed;
  } catch {
    throw new AppleIdTokenVerificationError(`Apple ID token ${label} không hợp lệ.`);
  }
}

function parseJwt(idToken) {
  if (typeof idToken !== 'string' || idToken.length < 40 || idToken.length > 12_000) {
    throw new AppleIdTokenVerificationError('Apple ID token không hợp lệ.');
  }

  const parts = idToken.split('.');
  if (parts.length !== 3) throw new AppleIdTokenVerificationError('Apple ID token không hợp lệ.');

  return {
    header: decodeBase64UrlJson(parts[0], 'header'),
    payload: decodeBase64UrlJson(parts[1], 'payload'),
    signature: parts[2],
    signedValue: `${parts[0]}.${parts[1]}`,
  };
}

function isUsableAppleKey(key) {
  return key
    && key.kty === 'RSA'
    && typeof key.kid === 'string'
    && typeof key.n === 'string'
    && typeof key.e === 'string';
}

function mergeAppleKeys(...keySets) {
  const keysById = new Map();
  for (const keySet of keySets) {
    for (const key of keySet ?? []) {
      if (isUsableAppleKey(key) && !keysById.has(key.kid)) keysById.set(key.kid, key);
    }
  }
  return Array.from(keysById.values());
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function fetchAppleKeys() {
  let lastError = null;

  for (const delayMs of JWKS_REQUEST_RETRY_DELAYS_MS) {
    if (delayMs > 0) await wait(delayMs);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), JWKS_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(APPLE_JWKS_URL, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`Apple JWKS returned ${response.status}.`);

      const body = await response.json();
      const keys = Array.isArray(body?.keys) ? body.keys.filter(isUsableAppleKey) : [];
      if (keys.length === 0) throw new Error('Apple JWKS response has no usable RSA keys.');

      cachedRemoteKeys = keys;
      cachedRemoteKeysExpiresAt = Date.now() + JWKS_CACHE_TTL_MS;
      cachedRemoteKeysUpdatedAt = new Date().toISOString();
      return keys;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new AppleKeySetUnavailableError(
    `Không thể tải khóa xác minh Sign in with Apple sau ${JWKS_REQUEST_RETRY_DELAYS_MS.length} lần thử: ${lastError instanceof Error ? lastError.message : 'unknown error'}`,
  );
}

async function resolveAppleKeys(forceRefresh = false) {
  const hasRemoteKeys = Array.isArray(cachedRemoteKeys) && cachedRemoteKeys.length > 0;
  if (!forceRefresh && hasRemoteKeys && cachedRemoteKeysExpiresAt > Date.now()) {
    return {
      keys: cachedRemoteKeys,
      source: 'cache',
      refreshError: null,
    };
  }

  try {
    const remoteKeys = await fetchAppleKeys();
    return {
      keys: remoteKeys,
      source: 'remote',
      refreshError: null,
    };
  } catch (error) {
    return {
      keys: mergeAppleKeys(cachedRemoteKeys, BUNDLED_APPLE_JWKS),
      source: hasRemoteKeys ? 'stale-cache' : 'bundled',
      refreshError: error instanceof AppleKeySetUnavailableError
        ? error
        : new AppleKeySetUnavailableError('Không thể tải khóa xác minh Sign in with Apple.'),
    };
  }
}

function hasFreshRemoteKeyCache() {
  return Array.isArray(cachedRemoteKeys)
    && cachedRemoteKeys.length > 0
    && cachedRemoteKeysExpiresAt > Date.now();
}

function getMatchingKey(keys, kid) {
  return keys.find((key) => key.kid === kid) || null;
}

function audienceMatches(audience, acceptedAudiences) {
  const actualAudiences = Array.isArray(audience) ? audience : [audience];
  return actualAudiences.some((value) => (
    typeof value === 'string' && acceptedAudiences.includes(value)
  ));
}

function validateClaims(payload, acceptedAudiences) {
  if (payload.iss !== APPLE_ISSUER) {
    throw new AppleIdTokenVerificationError('Apple ID token có issuer không hợp lệ.');
  }
  if (!audienceMatches(payload.aud, acceptedAudiences)) {
    throw new AppleIdTokenVerificationError('Apple ID token không dành cho ứng dụng này.');
  }

  const nowInSeconds = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= nowInSeconds) {
    throw new AppleIdTokenVerificationError('Apple ID token đã hết hạn.');
  }
  if (typeof payload.iat === 'number' && payload.iat > nowInSeconds + 5 * 60) {
    throw new AppleIdTokenVerificationError('Apple ID token có thời gian phát hành không hợp lệ.');
  }
  if (typeof payload.sub !== 'string' || payload.sub.trim().length === 0 || payload.sub.length > 255) {
    throw new AppleIdTokenVerificationError('Apple ID token không có định danh người dùng hợp lệ.');
  }
}

/**
 * Cryptographically verifies an ID token issued by Apple and returns only the
 * claims required to create or locate a local account.
 */
export async function verifyAppleIdToken(idToken, acceptedAudiences) {
  if (!Array.isArray(acceptedAudiences) || acceptedAudiences.length === 0) {
    throw new AppleIdTokenVerificationError('Máy chủ chưa cấu hình Apple client ID.');
  }

  const { header, payload, signature, signedValue } = parseJwt(idToken);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length === 0) {
    throw new AppleIdTokenVerificationError('Apple ID token dùng thuật toán hoặc key ID không hợp lệ.');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(signature)) {
    throw new AppleIdTokenVerificationError('Apple ID token signature không hợp lệ.');
  }

  const hasFreshKeys = hasFreshRemoteKeyCache();
  const locallyKnownKeys = hasFreshKeys
    ? cachedRemoteKeys
    : mergeAppleKeys(cachedRemoteKeys, BUNDLED_APPLE_JWKS);
  let key = getMatchingKey(locallyKnownKeys, header.kid);
  let keySet = null;

  // A cold start or a temporary egress outage must not make the client wait
  // longer than its API timeout when the key is already bundled/cached. Refresh
  // in the background; a fresh remote key set is always preferred when present.
  if (key && !hasFreshKeys) {
    void warmAppleIdTokenVerificationKeys().catch(() => undefined);
  }

  if (!key) {
    keySet = await resolveAppleKeys(true);
    key = getMatchingKey(keySet.keys, header.kid);
  }
  if (!key) {
    if (keySet?.refreshError) throw keySet.refreshError;
    throw new AppleIdTokenVerificationError('Không tìm thấy khóa xác minh Apple phù hợp.');
  }

  let signatureValid = false;
  try {
    const publicKey = createPublicKey({ key, format: 'jwk' });
    signatureValid = verifySignature(
      'RSA-SHA256',
      Buffer.from(signedValue, 'utf8'),
      publicKey,
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    throw new AppleIdTokenVerificationError('Apple ID token signature không hợp lệ.');
  }
  if (!signatureValid) throw new AppleIdTokenVerificationError('Apple ID token signature không hợp lệ.');

  validateClaims(payload, acceptedAudiences);
  return {
    subject: payload.sub.trim(),
    email: typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '',
  };
}

/**
 * Preloads Apple's rotating signing keys without making authentication depend
 * on the network at the moment a user presses the Apple sign-in button.
 */
export async function warmAppleIdTokenVerificationKeys() {
  const keySet = await resolveAppleKeys(true);
  return {
    source: keySet.source,
    keyCount: keySet.keys.length,
    remoteKeysUpdatedAt: cachedRemoteKeysUpdatedAt,
    refreshError: keySet.refreshError?.message ?? null,
  };
}
