import { createHash, randomBytes } from 'node:crypto';
import { Session } from '../models/Session.js';

export const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days for mobile app sessions

export function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createTokenPair() {
  const accessToken = `cg_at_${randomBytes(32).toString('base64url')}`;
  const refreshToken = `cg_rt_${randomBytes(48).toString('base64url')}`;
  const accessTokenExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);

  return { accessToken, refreshToken, accessTokenExpiresAt };
}

export async function createUserSession({ userId, userAgent, ipAddress }) {
  const tokens = createTokenPair();
  await Session.create({
    userId,
    accessTokenHash: hashSessionToken(tokens.accessToken),
    refreshTokenHash: hashSessionToken(tokens.refreshToken),
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    lastUsedAt: new Date(),
    userAgent: String(userAgent || '').slice(0, 500),
    ipAddress: String(ipAddress || '').slice(0, 100),
  });
  return tokens;
}

export function sessionPayload(tokens) {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    accessTokenExpiresInSeconds: ACCESS_TOKEN_TTL_MS / 1000,
  };
}
