import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { Session } from '../models/Session.js';
import { User } from '../models/User.js';
import {
  createTokenPair,
  createUserSession,
  hashSessionToken,
  sessionPayload,
} from '../services/session-service.js';
import { emitLocationToRecipients, setLocationSharing } from '../services/location-sharing-service.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DUMMY_PASSWORD_HASH =
  '$2b$12$KaTooWYzplvAx2awjvFqP.hjxYoapbyBBAqhraDE8T2y/W7kQN2.2';
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_LOGINS = 8;
const loginWindows = new Map();

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function databaseUnavailable(response) {
  return response.status(503).json({
    code: 'DATABASE_UNAVAILABLE',
    message: 'Cơ sở dữ liệu đang tạm thời không khả dụng. Vui lòng thử lại sau.',
  });
}

function getLoginWindowKey(request, email) {
  return `${request.ip || 'unknown'}:${email}`;
}

function getActiveLoginWindow(key) {
  const current = loginWindows.get(key);
  if (!current || Date.now() - current.startedAt >= LOGIN_WINDOW_MS) {
    loginWindows.delete(key);
    return null;
  }
  return current;
}

function loginIsBlocked(key) {
  return (getActiveLoginWindow(key)?.count ?? 0) >= MAX_FAILED_LOGINS;
}

function recordFailedLogin(key) {
  const current = getActiveLoginWindow(key);
  if (current) current.count += 1;
  else loginWindows.set(key, { count: 1, startedAt: Date.now() });

  if (loginWindows.size > 5000) {
    for (const [storedKey] of loginWindows) getActiveLoginWindow(storedKey);
  }
}

function extractBearerToken(request) {
  const authorization = request.get('authorization') || '';
  const [scheme, token] = authorization.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token.trim() : '';
}

function invalidSession(response, message = 'Phiên đăng nhập không hợp lệ.') {
  return response.status(401).json({ code: 'SESSION_INVALID', message });
}

export function createSessionRouter({ isDatabaseReady, emitSocialEvent = () => undefined }) {
  const router = Router();

  router.post('/login', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);

    const email = normalizeEmail(request.body?.email);
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    const errors = {};
    if (!EMAIL_PATTERN.test(email) || email.length > 254) {
      errors.email = 'Email không hợp lệ.';
    }
    if (!password) errors.password = 'Vui lòng nhập mật khẩu.';
    else if (password.length > 72) errors.password = 'Mật khẩu không hợp lệ.';
    if (Object.keys(errors).length > 0) {
      return response.status(422).json({ code: 'VALIDATION_ERROR', errors });
    }

    const loginKey = getLoginWindowKey(request, email);
    if (loginIsBlocked(loginKey)) {
      return response.status(429).json({
        code: 'LOGIN_RATE_LIMITED',
        message: 'Bạn đã đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.',
      });
    }

    try {
      const user = await User.findOne({ email }).select('+passwordHash');
      const passwordMatches = await bcrypt.compare(
        password,
        user?.passwordHash || DUMMY_PASSWORD_HASH,
      );

      if (!user || !passwordMatches) {
        recordFailedLogin(loginKey);
        return response.status(401).json({
          code: 'INVALID_CREDENTIALS',
          message: 'Email hoặc mật khẩu không đúng.',
        });
      }

      loginWindows.delete(loginKey);
      const tokens = await createUserSession({
        userId: user._id,
        userAgent: request.get('user-agent'),
        ipAddress: request.ip,
      });

      return response.json({
        message: 'Đăng nhập thành công.',
        user: user.toJSON(),
        ...sessionPayload(tokens),
      });
    } catch (error) {
      console.error('Login failed:', error);
      return response.status(500).json({
        code: 'LOGIN_FAILED',
        message: 'Không thể đăng nhập lúc này. Vui lòng thử lại.',
      });
    }
  });

  router.post('/refresh', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);

    const refreshToken =
      typeof request.body?.refreshToken === 'string' ? request.body.refreshToken.trim() : '';
    if (!refreshToken) return invalidSession(response);

    const currentRefreshHash = hashSessionToken(refreshToken);
    try {
      const existingSession = await Session.findOne({
        refreshTokenHash: currentRefreshHash,
      });
      if (!existingSession) return invalidSession(response, 'Phiên đăng nhập đã bị thu hồi.');

      const user = await User.findById(existingSession.userId);
      if (!user) {
        await Session.deleteOne({ _id: existingSession._id });
        return invalidSession(response, 'Tài khoản không còn tồn tại.');
      }

      const tokens = createTokenPair();
      const updatedSession = await Session.findOneAndUpdate(
        { _id: existingSession._id, refreshTokenHash: currentRefreshHash },
        {
          $set: {
            accessTokenHash: hashSessionToken(tokens.accessToken),
            refreshTokenHash: hashSessionToken(tokens.refreshToken),
            accessTokenExpiresAt: tokens.accessTokenExpiresAt,
            lastUsedAt: new Date(),
            userAgent: String(request.get('user-agent') || '').slice(0, 500),
            ipAddress: String(request.ip || '').slice(0, 100),
          },
        },
        { new: true },
      );
      if (!updatedSession) return invalidSession(response, 'Phiên đăng nhập đã thay đổi.');

      return response.json({
        message: 'Đã làm mới phiên đăng nhập.',
        user: user.toJSON(),
        ...sessionPayload(tokens),
      });
    } catch (error) {
      console.error('Refresh session failed:', error);
      return response.status(500).json({
        code: 'REFRESH_FAILED',
        message: 'Không thể làm mới phiên đăng nhập lúc này.',
      });
    }
  });

  router.get('/session', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);

    const accessToken = extractBearerToken(request);
    if (!accessToken) return invalidSession(response);

    try {
      const session = await Session.findOne({
        accessTokenHash: hashSessionToken(accessToken),
        accessTokenExpiresAt: { $gt: new Date() },
      });
      if (!session) return invalidSession(response);

      const user = await User.findById(session.userId);
      if (!user) {
        await Session.deleteOne({ _id: session._id });
        return invalidSession(response, 'Tài khoản không còn tồn tại.');
      }

      session.lastUsedAt = new Date();
      await session.save();
      return response.json({ user: user.toJSON() });
    } catch (error) {
      console.error('Validate session failed:', error);
      return response.status(500).json({
        code: 'SESSION_CHECK_FAILED',
        message: 'Không thể kiểm tra phiên đăng nhập lúc này.',
      });
    }
  });

  router.post('/logout', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);

    const accessToken = extractBearerToken(request);
    const refreshToken =
      typeof request.body?.refreshToken === 'string' ? request.body.refreshToken.trim() : '';
    const tokenConditions = [];
    if (accessToken) tokenConditions.push({ accessTokenHash: hashSessionToken(accessToken) });
    if (refreshToken) tokenConditions.push({ refreshTokenHash: hashSessionToken(refreshToken) });

    try {
      const activeSession = tokenConditions.length > 0
        ? await Session.findOne({ $or: tokenConditions }).select('userId')
        : null;
      if (activeSession) {
        const user = await User.findById(activeSession.userId).select('friends locationSharingEnabled locationSharingRecipientIds');
        if (user?.locationSharingEnabled) {
          await setLocationSharing(user, false);
          emitLocationToRecipients(user, emitSocialEvent, 'map:location-stopped', { userId: user._id.toString() });
        }
      }
      if (tokenConditions.length > 0) await Session.deleteMany({ $or: tokenConditions });
      return response.json({ message: 'Đăng xuất thành công.' });
    } catch (error) {
      console.error('Logout failed:', error);
      return response.status(500).json({
        code: 'LOGOUT_FAILED',
        message: 'Không thể đăng xuất khỏi máy chủ lúc này.',
      });
    }
  });

  return router;
}
