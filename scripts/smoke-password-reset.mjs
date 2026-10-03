import 'dotenv/config';
import { once } from 'node:events';
import bcrypt from 'bcryptjs';
import express from 'express';
import mongoose from 'mongoose';
import { PasswordReset } from '../src/models/PasswordReset.js';
import { User } from '../src/models/User.js';
import { createPasswordResetRouter } from '../src/routes/password-reset.js';

if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI chưa được cấu hình.');

const email = `camera-go-reset-${Date.now()}@example.com`;
const otp = '314159';
let server;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function post(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

try {
  await mongoose.connect(process.env.MONGODB_URI);
  const user = await User.create({
    fullName: 'Camera Daily Reset Test',
    email,
    passwordHash: await bcrypt.hash('OldPass123', 10),
  });
  await PasswordReset.create({
    userId: user._id,
    email,
    otpHash: await bcrypt.hash(otp, 10),
    otpExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
    lastSentAt: new Date(),
    deleteAt: new Date(Date.now() + 5 * 60 * 1000),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/auth', createPasswordResetRouter({ isDatabaseReady: () => true }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const wrongOtp = await post(baseUrl, '/api/auth/forgot-password/verify', {
    email,
    otp: '000000',
  });
  assert(wrongOtp.status === 400, 'OTP sai phải bị từ chối.');
  assert(wrongOtp.body.remainingAttempts === 4, 'Số lần thử OTP chưa được giảm đúng.');

  const verified = await post(baseUrl, '/api/auth/forgot-password/verify', { email, otp });
  assert(verified.status === 200, 'OTP đúng phải được xác minh.');
  assert(verified.body.resetToken, 'Thiếu reset token sau khi xác minh OTP.');

  const weakPassword = await post(baseUrl, '/api/auth/forgot-password/reset', {
    email,
    resetToken: verified.body.resetToken,
    newPassword: '12345678',
  });
  assert(weakPassword.status === 422, 'Mật khẩu yếu phải bị từ chối.');

  const newPassword = 'NewCamera123';
  const reset = await post(baseUrl, '/api/auth/forgot-password/reset', {
    email,
    resetToken: verified.body.resetToken,
    newPassword,
  });
  assert(reset.status === 200, 'Không thể cập nhật mật khẩu hợp lệ.');

  const updatedUser = await User.findById(user._id).select('+passwordHash');
  assert(
    updatedUser && (await bcrypt.compare(newPassword, updatedUser.passwordHash)),
    'Mật khẩu mới chưa được lưu đúng.',
  );

  const reusedToken = await post(baseUrl, '/api/auth/forgot-password/reset', {
    email,
    resetToken: verified.body.resetToken,
    newPassword: 'AnotherPass123',
  });
  assert(reusedToken.status === 401, 'Reset token phải chỉ được dùng một lần.');

  console.log('Password reset smoke test: OK');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState) {
    await PasswordReset.deleteMany({ email });
    await User.deleteMany({ email });
    await mongoose.disconnect();
  }
}
