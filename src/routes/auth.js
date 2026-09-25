import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 6;

function normalizeFullName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
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
      const user = await User.create({ fullName, email, passwordHash });

      return response.status(201).json({
        message: 'Đăng ký tài khoản thành công.',
        user: user.toJSON(),
      });
    } catch (error) {
      if (error?.code === 11000) {
        return response.status(409).json({
          code: 'EMAIL_EXISTS',
          errors: { email: 'Email này đã được sử dụng.' },
        });
      }

      console.error('Register failed:', error);
      return response.status(500).json({
        code: 'REGISTER_FAILED',
        message: 'Không thể đăng ký tài khoản lúc này.',
      });
    }
  });

  return router;
}
