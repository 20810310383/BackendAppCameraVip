import 'dotenv/config';
import { once } from 'node:events';
import bcrypt from 'bcryptjs';
import express from 'express';
import mongoose from 'mongoose';
import { Session } from '../src/models/Session.js';
import { User } from '../src/models/User.js';
import { createSessionRouter } from '../src/routes/session.js';
import { hashSessionToken } from '../src/services/session-service.js';

if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI chưa được cấu hình.');

const email = `camera-go-session-${Date.now()}@example.com`;
const password = 'CameraLogin123';
let server;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(baseUrl, path, { body, accessToken } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

try {
  await mongoose.connect(process.env.MONGODB_URI);
  const user = await User.create({
    fullName: 'Camera Go Session Test',
    email,
    passwordHash: await bcrypt.hash(password, 10),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/auth', createSessionRouter({ isDatabaseReady: () => true }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const wrongLogin = await request(baseUrl, '/api/auth/login', {
    body: { email, password: 'WrongPassword' },
  });
  assert(wrongLogin.status === 401, 'Sai mật khẩu phải bị từ chối.');

  const login = await request(baseUrl, '/api/auth/login', {
    body: { email, password },
  });
  assert(login.status === 200, 'Thông tin đúng phải đăng nhập thành công.');
  assert(login.body.accessToken && login.body.refreshToken, 'Thiếu token đăng nhập.');

  const storedSession = await Session.findOne({ userId: user._id }).select(
    '+accessTokenHash +refreshTokenHash',
  );
  assert(storedSession, 'Phiên chưa được lưu vào MongoDB.');
  assert(
    storedSession.accessTokenHash === hashSessionToken(login.body.accessToken),
    'Access token chưa được lưu đúng dạng hash.',
  );
  assert(
    storedSession.refreshTokenHash === hashSessionToken(login.body.refreshToken),
    'Refresh token chưa được lưu đúng dạng hash.',
  );
  assert(storedSession.accessTokenHash !== login.body.accessToken, 'Đã lưu access token dạng rõ.');

  const validSession = await request(baseUrl, '/api/auth/session', {
    accessToken: login.body.accessToken,
  });
  assert(validSession.status === 200, 'Access token hợp lệ không được chấp nhận.');

  await Session.updateOne(
    { _id: storedSession._id },
    { $set: { accessTokenExpiresAt: new Date(Date.now() - 1000) } },
  );
  const expiredAccess = await request(baseUrl, '/api/auth/session', {
    accessToken: login.body.accessToken,
  });
  assert(expiredAccess.status === 401, 'Access token hết hạn phải bị từ chối.');

  const refreshed = await request(baseUrl, '/api/auth/refresh', {
    body: { refreshToken: login.body.refreshToken },
  });
  assert(refreshed.status === 200, 'Refresh token hợp lệ không làm mới được phiên.');
  assert(
    refreshed.body.refreshToken !== login.body.refreshToken,
    'Refresh token chưa được xoay vòng.',
  );

  const reusedRefresh = await request(baseUrl, '/api/auth/refresh', {
    body: { refreshToken: login.body.refreshToken },
  });
  assert(reusedRefresh.status === 401, 'Refresh token cũ phải bị vô hiệu hóa.');

  const refreshedSession = await request(baseUrl, '/api/auth/session', {
    accessToken: refreshed.body.accessToken,
  });
  assert(refreshedSession.status === 200, 'Access token mới không hợp lệ.');

  const logout = await request(baseUrl, '/api/auth/logout', {
    accessToken: refreshed.body.accessToken,
    body: { refreshToken: refreshed.body.refreshToken },
  });
  assert(logout.status === 200, 'Đăng xuất không thành công.');
  assert((await Session.countDocuments({ userId: user._id })) === 0, 'Phiên chưa bị xóa.');

  const refreshAfterLogout = await request(baseUrl, '/api/auth/refresh', {
    body: { refreshToken: refreshed.body.refreshToken },
  });
  assert(refreshAfterLogout.status === 401, 'Token sau đăng xuất vẫn còn hợp lệ.');

  console.log('Authentication session smoke test: OK');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState) {
    await Session.deleteMany({ userId: (await User.findOne({ email }))?._id });
    await User.deleteMany({ email });
    await mongoose.disconnect();
  }
}
