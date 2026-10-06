import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { OAuth2Client } from 'google-auth-library';
import { User } from '../models/User.js';
import {
  AppleIdTokenVerificationError,
  AppleKeySetUnavailableError,
  verifyAppleIdToken,
} from '../services/apple-id-token.js';
import { createUserSession, sessionPayload } from '../services/session-service.js';
import { findAvailableUsername } from '../services/username-service.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 6;
const googleTokenVerifier = new OAuth2Client();

function normalizeFullName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function googleAudienceClientIds() {
  const raw = [
    process.env.GOOGLE_OAUTH_CLIENT_IDS,
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_WEB_CLIENT_ID,
    process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  ];
  const ids = raw
    .filter(Boolean)
    .flatMap((val) => String(val).split(','))
    .map((clientId) => clientId.trim())
    .filter(Boolean);
  return Array.from(new Set(ids));
}

function appleAudienceClientIds() {
  const raw = [
    process.env.APPLE_OAUTH_CLIENT_IDS,
    process.env.APPLE_CLIENT_ID,
    process.env.APPLE_BUNDLE_ID,
    // The native app's production bundle identifier. Environment variables
    // may add other approved release identifiers.
    'com.cameradaily.app',
  ];
  const ids = raw
    .filter(Boolean)
    .flatMap((val) => String(val).split(','))
    .map((clientId) => clientId.trim())
    .filter(Boolean);
  return Array.from(new Set(ids));
}

function googleProfileName(name, email) {
  const normalizedName = normalizeFullName(name).slice(0, 80);
  if (normalizedName.length >= 2) return normalizedName;

  const fallbackName = normalizeFullName(
    email.split('@')[0].replace(/[._-]+/g, ' '),
  ).slice(0, 80);
  return fallbackName.length >= 2 ? fallbackName : 'Google User';
}

async function createGoogleUser({ email, fullName, googleSubject, avatarPath = '' }) {
  let user;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const username = await findAvailableUsername(User, email.split('@')[0]);
    try {
      user = await User.create({ email, fullName, username, googleSubject, avatarPath });
      break;
    } catch (error) {
      if (error?.code !== 11000 || !error?.keyPattern?.username || attempt === 2) throw error;
    }
  }
  return user;
}

function appleProfileName(name, email) {
  const normalizedName = normalizeFullName(name).slice(0, 80);
  if (normalizedName.length >= 2) return normalizedName;

  const fallbackName = normalizeFullName(
    email.split('@')[0].replace(/[._-]+/g, ' '),
  ).slice(0, 80);
  return fallbackName.length >= 2 ? fallbackName : 'Apple User';
}

async function createAppleUser({ email, fullName, appleSubject }) {
  let user;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const username = await findAvailableUsername(User, email.split('@')[0]);
    try {
      user = await User.create({ email, fullName, username, appleSubject });
      break;
    } catch (error) {
      if (error?.code !== 11000 || !error?.keyPattern?.username || attempt === 2) throw error;
    }
  }
  return user;
}

function validateRegistration({ fullName, email, password }) {
  const errors = {};

  if (fullName.length < 2) {
    errors.fullName = 'Họ và tên phải có ít nhất 2 ký tự.';
  } else if (fullName.length > 80) {
    errors.fullName = 'Họ và tên không được vượt quá 80 ký tự.';
  }

  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    errors.email = 'Email không hợp lệ.';
  }

  if (password.length < PASSWORD_MIN_LENGTH) {
    errors.password = `Mật khẩu phải có ít nhất ${PASSWORD_MIN_LENGTH} ký tự.`;
  } else if (password.length > 72) {
    errors.password = 'Mật khẩu không được vượt quá 72 ký tự.';
  }

  return errors;
}

function databaseUnavailable(response) {
  return response.status(503).json({
    code: 'DATABASE_UNAVAILABLE',
    message: 'Cơ sở dữ liệu đang tạm thời không khả dụng. Vui lòng thử lại sau.',
  });
}

export function createAuthRouter({ isDatabaseReady }) {
  const router = Router();

  router.get('/check-email', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);

    const email = normalizeEmail(request.query.email);
    if (!EMAIL_PATTERN.test(email)) {
      return response.status(422).json({
        code: 'VALIDATION_ERROR',
        errors: { email: 'Email không hợp lệ.' },
      });
    }

    try {
      const exists = Boolean(await User.exists({ email }));
      return response.json({ email, available: !exists });
    } catch (error) {
      console.error('Check email failed:', error);
      return response.status(500).json({
        code: 'CHECK_EMAIL_FAILED',
        message: 'Không thể kiểm tra email lúc này.',
      });
    }
  });

  router.post('/register', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);

    const fullName = normalizeFullName(request.body?.fullName);
    const email = normalizeEmail(request.body?.email);
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    const errors = validateRegistration({ fullName, email, password });

    if (Object.keys(errors).length > 0) {
      return response.status(422).json({ code: 'VALIDATION_ERROR', errors });
    }

    try {
      const existingUser = await User.exists({ email });
      if (existingUser) {
        return response.status(409).json({
          code: 'EMAIL_EXISTS',
          errors: { email: 'Email này đã được sử dụng.' },
        });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      let user;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const username = await findAvailableUsername(User, email.split('@')[0]);
        try {
          user = await User.create({ fullName, email, username, passwordHash });
          break;
        } catch (error) {
          if (error?.code !== 11000 || !error?.keyPattern?.username || attempt === 2) throw error;
        }
      }

      return response.status(201).json({
        message: 'Đăng ký tài khoản thành công.',
        user: user.toJSON(),
      });
    } catch (error) {
      if (error?.code === 11000) {
        const isUsernameConflict = Boolean(error?.keyPattern?.username);
        return response.status(409).json({
          code: isUsernameConflict ? 'USERNAME_EXISTS' : 'EMAIL_EXISTS',
          errors: isUsernameConflict
            ? { username: 'Không thể tạo username khả dụng. Vui lòng thử lại.' }
            : { email: 'Email này đã được sử dụng.' },
        });
      }

      console.error('Register failed:', error);
      return response.status(500).json({
        code: 'REGISTER_FAILED',
        message: 'Không thể đăng ký tài khoản lúc này.',
      });
    }
  });

  router.post('/google', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);

    const idToken = typeof request.body?.idToken === 'string' ? request.body.idToken.trim() : '';
    if (!idToken || idToken.length > 12_000) {
      return response.status(422).json({
        code: 'VALIDATION_ERROR',
        errors: { idToken: 'ID token Google không hợp lệ.' },
      });
    }

    const audiences = googleAudienceClientIds();
    if (audiences.length === 0) {
      console.error('Google sign-in is not configured: GOOGLE_OAUTH_CLIENT_IDS is missing.');
      return response.status(503).json({
        code: 'GOOGLE_AUTH_NOT_CONFIGURED',
        message: 'Đăng nhập Google chưa được cấu hình trên máy chủ.',
      });
    }

    let googleProfile;
    try {
      const ticket = await googleTokenVerifier.verifyIdToken({ idToken, audience: audiences });
      googleProfile = ticket.getPayload();
    } catch (error) {
      console.warn(`Google ID token verification failed: ${error.message}`);
      return response.status(401).json({
        code: 'GOOGLE_TOKEN_INVALID',
        message: 'Phiên xác thực Google không hợp lệ hoặc đã hết hạn. Vui lòng thử lại.',
      });
    }

    const email = normalizeEmail(googleProfile?.email);
    const googleSubject = typeof googleProfile?.sub === 'string' ? googleProfile.sub.trim() : '';
    if (!googleSubject || !EMAIL_PATTERN.test(email) || googleProfile?.email_verified !== true) {
      return response.status(401).json({
        code: 'GOOGLE_EMAIL_UNVERIFIED',
        message: 'Google chưa xác minh địa chỉ email này.',
      });
    }

    try {
      let user = await User.findOne({ googleSubject });

      if (!user) {
        const userWithSameEmail = await User.findOne({ email });
        if (userWithSameEmail) {
          if (userWithSameEmail.googleSubject && userWithSameEmail.googleSubject !== googleSubject) {
            return response.status(409).json({
              code: 'GOOGLE_ACCOUNT_LINK_CONFLICT',
              message: 'Email này đã được liên kết với một tài khoản Google khác.',
            });
          }

          // Link a verified Google email to its existing password account.
          userWithSameEmail.googleSubject = googleSubject;
          if (!userWithSameEmail.avatarPath && typeof googleProfile?.picture === 'string' && googleProfile.picture.trim()) {
            userWithSameEmail.avatarPath = googleProfile.picture.trim();
          }
          await userWithSameEmail.save();
          user = userWithSameEmail;
        } else {
          user = await createGoogleUser({
            email,
            fullName: googleProfileName(googleProfile?.name, email),
            googleSubject,
            avatarPath: typeof googleProfile?.picture === 'string' ? googleProfile.picture.trim() : '',
          });
        }
      }

      const tokens = await createUserSession({
        userId: user._id,
        userAgent: request.get('user-agent'),
        ipAddress: request.ip,
      });

      return response.json({
        message: 'Đăng nhập Google thành công.',
        user: user.toJSON(),
        ...sessionPayload(tokens),
      });
    } catch (error) {
      if (error?.code === 11000 && error?.keyPattern?.email) {
        return response.status(409).json({
          code: 'EMAIL_EXISTS',
          message: 'Không thể liên kết tài khoản Google với email này. Vui lòng thử lại.',
        });
      }

      console.error('Google sign-in failed:', error);
      return response.status(500).json({
        code: 'GOOGLE_LOGIN_FAILED',
        message: 'Không thể đăng nhập Google lúc này. Vui lòng thử lại.',
      });
    }
  });

  router.post('/apple', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);

    const idToken = typeof request.body?.idToken === 'string' ? request.body.idToken.trim() : '';
    if (!idToken || idToken.length > 12_000) {
      return response.status(422).json({
        code: 'VALIDATION_ERROR',
        errors: { idToken: 'ID token Apple không hợp lệ.' },
      });
    }

    let appleProfile;
    try {
      appleProfile = await verifyAppleIdToken(idToken, appleAudienceClientIds());
    } catch (error) {
      if (error instanceof AppleKeySetUnavailableError) {
        console.error('Apple token verification keys unavailable:', error.message);
        return response.status(503).json({
          code: 'APPLE_AUTH_UNAVAILABLE',
          message: 'Không thể xác minh tài khoản Apple lúc này. Vui lòng thử lại.',
        });
      }

      console.warn('Apple ID token verification failed:', error instanceof Error ? error.message : error);
      return response.status(401).json({
        code: error instanceof AppleIdTokenVerificationError ? 'APPLE_TOKEN_INVALID' : 'APPLE_TOKEN_VERIFICATION_FAILED',
        message: 'Phiên xác thực Apple không hợp lệ hoặc đã hết hạn. Vui lòng thử lại.',
      });
    }

    const appleSubject = appleProfile.subject;
    const email = normalizeEmail(appleProfile.email);
    const fullName = normalizeFullName(request.body?.fullName);

    try {
      let user = await User.findOne({ appleSubject });

      if (!user) {
        if (!EMAIL_PATTERN.test(email)) {
          return response.status(422).json({
            code: 'APPLE_EMAIL_REQUIRED',
            message: 'Apple không cung cấp email cho lần đăng nhập đầu tiên. Vui lòng thử lại và cho phép chia sẻ email.',
          });
        }

        const userWithSameEmail = await User.findOne({ email });
        if (userWithSameEmail) {
          if (userWithSameEmail.appleSubject && userWithSameEmail.appleSubject !== appleSubject) {
            return response.status(409).json({
              code: 'APPLE_ACCOUNT_LINK_CONFLICT',
              message: 'Email này đã được liên kết với một tài khoản Apple khác.',
            });
          }

          // The email comes from Apple's signed token. Link it to an existing account,
          // following the same account-linking behavior as Google sign-in.
          userWithSameEmail.appleSubject = appleSubject;
          // The provider subject is immutable after it has been linked. This
          // explicit first link is the sole permitted update to that field.
          await userWithSameEmail.save({ overwriteImmutable: true });
          user = userWithSameEmail;
        } else {
          user = await createAppleUser({
            email,
            fullName: appleProfileName(fullName, email),
            appleSubject,
          });
        }
      }

      const tokens = await createUserSession({
        userId: user._id,
        userAgent: request.get('user-agent'),
        ipAddress: request.ip,
      });

      return response.json({
        message: 'Đăng nhập Apple thành công.',
        user: user.toJSON(),
        ...sessionPayload(tokens),
      });
    } catch (error) {
      if (error?.code === 11000) {
        return response.status(409).json({
          code: 'APPLE_ACCOUNT_LINK_CONFLICT',
          message: 'Không thể liên kết tài khoản Apple này. Vui lòng thử lại.',
        });
      }

      console.error('Apple sign-in failed:', error);
      return response.status(500).json({
        code: 'APPLE_LOGIN_FAILED',
        message: 'Không thể đăng nhập Apple lúc này. Vui lòng thử lại.',
      });
    }
  });

  return router;
}
