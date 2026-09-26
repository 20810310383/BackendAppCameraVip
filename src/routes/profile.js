import { randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { FriendRequest } from '../models/FriendRequest.js';
import { Session } from '../models/Session.js';
import { User } from '../models/User.js';
import { hashSessionToken } from '../services/session-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const uploadsDirectory = path.resolve(__dirname, '../../uploads');
export const profileUploadDirectory = path.resolve(__dirname, '../../uploads/profiles');
const MAX_UPLOAD_SIZE_BYTES = 12 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic', 'image/heif']);

const profileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_SIZE_BYTES, files: 2 },
  fileFilter: (_request, file, callback) => {
    if (IMAGE_MIME_TYPES.has(file.mimetype)) callback(null, true);
    else callback(new Error('Chỉ hỗ trợ ảnh JPG, PNG, WebP, AVIF hoặc HEIC.'));
  },
}).fields([
  { name: 'avatar', maxCount: 1 },
  { name: 'cover', maxCount: 1 },
]);

function normalizeFullName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function extractBearerToken(request) {
  const authorization = request.get('authorization') || '';
  const [scheme, token] = authorization.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token.trim() : '';
}

function databaseUnavailable(response) {
  return response.status(503).json({
    code: 'DATABASE_UNAVAILABLE',
    message: 'Cơ sở dữ liệu đang tạm thời không khả dụng. Vui lòng thử lại sau.',
  });
}

async function authenticatedUser(request, response) {
  const accessToken = extractBearerToken(request);
  if (!accessToken) {
    response.status(401).json({ code: 'SESSION_INVALID', message: 'Phiên đăng nhập không hợp lệ.' });
    return null;
  }
  const session = await Session.findOne({
    accessTokenHash: hashSessionToken(accessToken),
    accessTokenExpiresAt: { $gt: new Date() },
  });
  if (!session) {
    response.status(401).json({ code: 'SESSION_INVALID', message: 'Phiên đăng nhập đã hết hạn.' });
    return null;
  }
  const user = await User.findById(session.userId);
  if (!user) {
    response.status(401).json({ code: 'SESSION_INVALID', message: 'Tài khoản không còn tồn tại.' });
    return null;
  }
  return user;
}

async function profileStats(user) {
  const [outgoingRequests, incomingRequests] = await Promise.all([
    FriendRequest.countDocuments({ from: user._id }),
    FriendRequest.countDocuments({ to: user._id }),
  ]);
  const friends = (user.friends || []).length;
  return {
    posts: 0,
    friends,
    following: friends + outgoingRequests,
    followers: friends + incomingRequests,
  };
}

async function profilePayload(user) {
  return { user: user.toJSON(), stats: await profileStats(user) };
}

function friendProfilePayload(user, isUserOnline) {
  const publicUser = user.toJSON();
  delete publicUser.email;
  const isOnline = Boolean(isUserOnline(user._id));
  return profileStats(user).then((stats) => ({
    user: publicUser,
    stats,
    presence: {
      isOnline,
      lastActiveAt: user.lastActiveAt ? user.lastActiveAt.toISOString() : null,
    },
  }));
}

async function optimizeProfileImage(file, type, userId) {
  await mkdir(profileUploadDirectory, { recursive: true });
  const filename = `${type}-${userId}-${randomBytes(12).toString('hex')}.webp`;
  const destination = path.join(profileUploadDirectory, filename);
  const resizeOptions = type === 'avatar'
    ? { width: 1024, height: 1024, fit: 'cover', position: 'attention', withoutEnlargement: true }
    : { width: 1600, height: 900, fit: 'cover', position: 'attention', withoutEnlargement: true };

  const optimized = await sharp(file.buffer, { failOn: 'none', limitInputPixels: 24_000_000 })
    .rotate()
    .resize(resizeOptions)
    .webp({ quality: type === 'avatar' ? 94 : 78, effort: type === 'avatar' ? 5 : 4, smartSubsample: true })
    .toBuffer();

  await writeFile(destination, optimized);
  return `/uploads/profiles/${filename}`;
}

async function removeLocalProfileImage(imagePath) {
  if (!imagePath?.startsWith('/uploads/profiles/')) return;
  const filename = path.basename(imagePath);
  await unlink(path.join(profileUploadDirectory, filename)).catch(() => undefined);
}

function runProfileUpload(request, response, next) {
  profileUpload(request, response, (error) => {
    if (!error) return next();
    const tooLarge = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
    return response.status(tooLarge ? 413 : 422).json({
      code: tooLarge ? 'IMAGE_TOO_LARGE' : 'INVALID_IMAGE',
      errors: { image: tooLarge ? 'Mỗi ảnh tối đa 12 MB.' : error.message || 'Ảnh tải lên không hợp lệ.' },
    });
  });
}

export function createProfileRouter({ isDatabaseReady, emitSocialEvent = () => undefined, isUserOnline = () => false }) {
  const router = Router();

  router.get('/users/me/profile', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      return response.json(await profilePayload(user));
    } catch (error) {
      console.error('Get profile failed:', error);
      return response.status(500).json({ code: 'GET_PROFILE_FAILED', message: 'Không thể tải hồ sơ lúc này.' });
    }
  });

  router.get('/users/:userId/profile', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const friend = await User.findById(request.params.userId);
      if (!friend || !(user.friends || []).some((friendId) => friendId.equals(friend._id))) {
        return response.status(404).json({ code: 'FRIEND_PROFILE_NOT_FOUND', message: 'Hồ sơ này không còn trong danh sách bạn bè.' });
      }
      if ((friend.blockedUsers || []).some((blockedUserId) => blockedUserId.equals(user._id))) {
        return response.status(403).json({ code: 'PROFILE_UNAVAILABLE', message: 'Hồ sơ này hiện không khả dụng.' });
      }
      return response.json(await friendProfilePayload(friend, isUserOnline));
    } catch (error) {
      console.error('Get friend profile failed:', error);
      return response.status(500).json({ code: 'GET_FRIEND_PROFILE_FAILED', message: 'Không thể tải hồ sơ bạn bè lúc này.' });
    }
  });

  router.patch('/users/me/profile', runProfileUpload, async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    const newFiles = [];
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const fullName = normalizeFullName(request.body?.fullName);
      const bio = typeof request.body?.bio === 'string' ? request.body.bio.trim() : '';
      if (fullName.length < 2 || fullName.length > 80) {
        return response.status(422).json({
          code: 'VALIDATION_ERROR',
          errors: { fullName: 'Họ và tên cần có từ 2 đến 80 ký tự.' },
        });
      }
      if (bio.length > 500) {
        return response.status(422).json({
          code: 'VALIDATION_ERROR',
          errors: { bio: 'Mô tả không được vượt quá 500 ký tự.' },
        });
      }

      const files = request.files || {};
      const avatarFile = Array.isArray(files.avatar) ? files.avatar[0] : null;
      const coverFile = Array.isArray(files.cover) ? files.cover[0] : null;
      const previousAvatarPath = user.avatarPath;
      const previousCoverPath = user.coverPath;

      user.fullName = fullName;
      user.bio = bio;
      if (avatarFile) {
        user.avatarPath = await optimizeProfileImage(avatarFile, 'avatar', user._id);
        newFiles.push(user.avatarPath);
      }
      if (coverFile) {
        user.coverPath = await optimizeProfileImage(coverFile, 'cover', user._id);
        newFiles.push(user.coverPath);
      }
      await user.save();

      if (avatarFile) await removeLocalProfileImage(previousAvatarPath);
      if (coverFile) await removeLocalProfileImage(previousCoverPath);
      emitSocialEvent(user._id, 'social:profile-updated', { userId: user._id.toString() });
      for (const friendId of user.friends || []) {
        emitSocialEvent(friendId, 'social:friends-updated', { reason: 'profile_updated' });
      }
      return response.json({ message: 'Đã cập nhật hồ sơ.', ...(await profilePayload(user)) });
    } catch (error) {
      await Promise.all(newFiles.map(removeLocalProfileImage));
      console.error('Update profile failed:', error);
      return response.status(500).json({
        code: 'UPDATE_PROFILE_FAILED',
        message: 'Không thể cập nhật hồ sơ lúc này.',
      });
    }
  });

  return router;
}
