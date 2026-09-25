import { createHash, randomBytes, randomInt } from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { PasswordReset } from '../models/PasswordReset.js';
import { Session } from '../models/Session.js';
import { User } from '../models/User.js';
import { emailIsConfigured, sendPasswordResetOtp } from '../services/email-service.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_PATTERN = /^\d{6}$/;
const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).{8,72}$/;
const OTP_TTL_MS = 5 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_REQUEST_LIMIT = 8;
const requestWindows = new Map();

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function hashToken(value) {
  return createHash('sha256').update(value).digest('hex');
}

function databaseUnavailable(response) {
  return response.status(503).json({
    code: 'DATABASE_UNAVAILABLE',
    message: 'Cơ sở dữ liệu đang tạm thời không khả dụng.',
  });
}

function consumeIpRequest(ip) {
  const now = Date.now();
  const current = requestWindows.get(ip);
  if (!current || now - current.startedAt >= IP_WINDOW_MS) {
    requestWindows.set(ip, { count: 1, startedAt: now });
    return true;
  }
  if (current.count >= IP_REQUEST_LIMIT) return false;
  current.count += 1;
  return true;
}

export function createPasswordResetRouter({ isDatabaseReady }) {
  const router = Router();

  router.post('/forgot-password/request', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    if (!emailIsConfigured()) {
      return response.status(503).json({
        code: 'EMAIL_NOT_CONFIGURED',
        message: 'Dịch vụ email chưa được cấu hình.',
      });
    }
    if (!consumeIpRequest(request.ip || 'unknown')) {
      return response.status(429).json({
        code: 'TOO_MANY_REQUESTS',
        message: 'Bạn đã yêu cầu quá nhiều lần. Vui lòng thử lại sau.',
      });
    }

    const email = normalizeEmail(request.body?.email);
    if (!EMAIL_PATTERN.test(email)) {
      return response.status(422).json({
        code: 'VALIDATION_ERROR',
        errors: { email: 'Email không hợp lệ.' },
      });
    }

    try {
      const user = await User.findOne({ email });
      const genericResult = {
        message: 'Nếu email đã đăng ký, mã OTP sẽ được gửi đến hộp thư của bạn.',
        resendAfterSeconds: RESEND_COOLDOWN_MS / 1000,
        otpExpiresInSeconds: OTP_TTL_MS / 1000,
      };

      if (!user) return response.json(genericResult);

      const existingReset = await PasswordReset.findOne({ email });
      if (existingReset) {
        const retryAfterMs =
          RESEND_COOLDOWN_MS - (Date.now() - existingReset.lastSentAt.getTime());
        if (retryAfterMs > 0) {
          // Keep the same public response so this endpoint cannot be used to
          // determine whether an email belongs to an account.
          return response.json(genericResult);
        }
      }

      const otp = String(randomInt(100000, 1000000));
      const otpHash = await bcrypt.hash(otp, 10);
      const now = new Date();
      const otpExpiresAt = new Date(now.getTime() + OTP_TTL_MS);

      await PasswordReset.findOneAndUpdate(
        { email },
        {
          userId: user._id,
          email,
          otpHash,
          otpExpiresAt,
          attempts: 0,
          lastSentAt: now,
          verifiedAt: null,
          resetTokenHash: null,
          resetTokenExpiresAt: null,
          deleteAt: otpExpiresAt,
        },
        { upsert: true, new: true, runValidators: true },
      );

      try {
        await sendPasswordResetOtp({ to: email, fullName: user.fullName, otp });
      } catch (emailError) {
        await PasswordReset.deleteOne({ email, lastSentAt: now });
        console.error('Send password reset OTP failed:', emailError);
        return response.status(502).json({
          code: 'SEND_EMAIL_FAILED',
          message: 'Không thể gửi email OTP lúc này. Vui lòng thử lại.',
        });
      }

      return response.json(genericResult);
    } catch (error) {
      console.error('Request password reset failed:', error);
      return response.status(500).json({
        code: 'PASSWORD_RESET_REQUEST_FAILED',
        message: 'Không thể gửi mã OTP lúc này.',
      });
    }
  });

  router.post('/forgot-password/verify', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);

    const email = normalizeEmail(request.body?.email);
    const otp = typeof request.body?.otp === 'string' ? request.body.otp.trim() : '';
    if (!EMAIL_PATTERN.test(email) || !OTP_PATTERN.test(otp)) {
      return response.status(422).json({
        code: 'VALIDATION_ERROR',
        message: 'Mã OTP phải gồm đúng 6 chữ số.',
      });
    }

    try {
      const reset = await PasswordReset.findOne({ email }).select('+otpHash');
      if (!reset || !reset.otpHash) {
        return response.status(400).json({
          code: 'OTP_INVALID',
          message: 'Mã OTP không hợp lệ hoặc đã hết hạn.',
        });
      }
      if (reset.otpExpiresAt.getTime() <= Date.now()) {
        await PasswordReset.deleteOne({ _id: reset._id });
        return response.status(410).json({
          code: 'OTP_EXPIRED',
          message: 'Mã OTP đã hết hạn. Vui lòng gửi lại mã mới.',
        });
      }
      if (reset.attempts >= MAX_OTP_ATTEMPTS) {
        return response.status(429).json({
          code: 'OTP_TOO_MANY_ATTEMPTS',
          message: 'Bạn đã nhập sai quá nhiều lần. Vui lòng gửi lại mã mới.',
        });
      }

      const matched = await bcrypt.compare(otp, reset.otpHash);
      reset.attempts += 1;
      if (!matched) {
        await reset.save();
        const remainingAttempts = Math.max(0, MAX_OTP_ATTEMPTS - reset.attempts);
        return response.status(400).json({
          code: 'OTP_INVALID',
          message:
            remainingAttempts > 0
              ? `Mã OTP không đúng. Bạn còn ${remainingAttempts} lần thử.`
              : 'Bạn đã nhập sai quá nhiều lần. Vui lòng gửi lại mã mới.',
          remainingAttempts,
        });
      }

      const resetToken = randomBytes(32).toString('base64url');
      const resetTokenExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
      reset.otpHash = null;
      reset.verifiedAt = new Date();
      reset.resetTokenHash = hashToken(resetToken);
      reset.resetTokenExpiresAt = resetTokenExpiresAt;
      reset.deleteAt = resetTokenExpiresAt;
      await reset.save();

      return response.json({
        message: 'Xác minh OTP thành công.',
        resetToken,
        resetTokenExpiresInSeconds: RESET_TOKEN_TTL_MS / 1000,
      });
    } catch (error) {
      console.error('Verify password reset OTP failed:', error);
      return response.status(500).json({
        code: 'OTP_VERIFY_FAILED',
        message: 'Không thể xác minh OTP lúc này.',
      });
    }
  });

  router.post('/forgot-password/reset', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);

    const email = normalizeEmail(request.body?.email);
    const resetToken =
      typeof request.body?.resetToken === 'string' ? request.body.resetToken.trim() : '';
    const newPassword =
      typeof request.body?.newPassword === 'string' ? request.body.newPassword : '';

    if (!EMAIL_PATTERN.test(email) || !resetToken) {
      return response.status(422).json({
        code: 'VALIDATION_ERROR',
        message: 'Yêu cầu đặt lại mật khẩu không hợp lệ.',
      });
    }
    if (!PASSWORD_PATTERN.test(newPassword)) {
      return response.status(422).json({
        code: 'VALIDATION_ERROR',
        errors: {
          newPassword: 'Mật khẩu phải từ 8 ký tự và có ít nhất một chữ cái, một chữ số.',
        },
      });
    }

    try {
      const reset = await PasswordReset.findOneAndDelete({
        email,
        resetTokenHash: hashToken(resetToken),
        verifiedAt: { $ne: null },
        resetTokenExpiresAt: { $gt: new Date() },
      });

      if (!reset) {
        return response.status(401).json({
          code: 'RESET_TOKEN_INVALID',
          message: 'Phiên đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.',
        });
      }

      const passwordHash = await bcrypt.hash(newPassword, 12);
      const updateResult = await User.updateOne(
        { _id: reset.userId, email },
        { $set: { passwordHash } },
      );
      if (updateResult.matchedCount !== 1) {
        return response.status(404).json({
          code: 'USER_NOT_FOUND',
          message: 'Không tìm thấy tài khoản cần đặt lại mật khẩu.',
        });
      }

      // Password changes invalidate every existing device session.
      await Session.deleteMany({ userId: reset.userId });

      return response.json({ message: 'Mật khẩu đã được cập nhật thành công.' });
    } catch (error) {
      console.error('Reset password failed:', error);
      return response.status(500).json({
        code: 'PASSWORD_RESET_FAILED',
        message: 'Không thể cập nhật mật khẩu lúc này.',
      });
    }
  });

  return router;
}
