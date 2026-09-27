import { randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import sharp from 'sharp';
import { MomentPost } from '../models/MomentPost.js';
import { Session } from '../models/Session.js';
import { User } from '../models/User.js';
import { hashSessionToken } from '../services/session-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const momentUploadDirectory = path.resolve(__dirname, '../../uploads/moments');
const momentImageDirectory = path.join(momentUploadDirectory, 'images');
const momentVideoDirectory = path.join(momentUploadDirectory, 'videos');
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_VIDEO_BYTES = 40 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic', 'image/heif']);

const momentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_BYTES, files: 1 },
  fileFilter: (_request, file, callback) => {
    const isImage = IMAGE_MIME_TYPES.has(file.mimetype) || file.mimetype?.startsWith('image/');
    const isVideo = file.mimetype?.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(file.originalname);
    if (file.fieldname === 'media' && (isImage || isVideo)) return callback(null, true);
    return callback(new Error('Chỉ hỗ trợ ảnh hoặc video cho khoảnh khắc.'));
  },
}).single('media');

function databaseUnavailable(response) {
  return response.status(503).json({
    code: 'DATABASE_UNAVAILABLE',
    message: 'Cơ sở dữ liệu đang tạm thời không khả dụng. Vui lòng thử lại sau.',
  });
}

function extractBearerToken(request) {
  const authorization = request.get('authorization') || '';
  const [scheme, token] = authorization.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token.trim() : '';
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

function userPayload(user, isUserOnline) {
  return {
    id: user.id || user._id.toString(),
    fullName: user.fullName,
    username: user.username,
    avatarPath: user.avatarPath || '',
    isOnline: Boolean(isUserOnline(user._id)),
  };
}

function postPayload(post, isUserOnline) {
  const plain = typeof post.toObject === 'function' ? post.toObject() : post;
  return {
    id: plain._id?.toString() || plain.id,
    author: userPayload(plain.author, isUserOnline),
    media: plain.media,
    caption: plain.caption || '',
    stickers: Array.isArray(plain.stickers) ? plain.stickers : [],
    widget: plain.widget || null,
    viewCount: Array.isArray(plain.views) ? plain.views.length : 0,
    createdAt: new Date(plain.createdAt).toISOString(),
  };
}

function parseJsonField(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sanitizeStickers(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap((sticker) => {
    if (!sticker || typeof sticker.emoji !== 'string' || !sticker.emoji.trim()) return [];
    return [{
      emoji: sticker.emoji.trim().slice(0, 24),
      x: Number.isFinite(Number(sticker.x)) ? Number(sticker.x) : 0,
      y: Number.isFinite(Number(sticker.y)) ? Number(sticker.y) : 0,
      scale: Math.max(0.25, Math.min(4, Number(sticker.scale) || 1)),
      rotation: Math.max(-360, Math.min(360, Number(sticker.rotation) || 0)),
    }];
  });
}

function sanitizeWidget(value) {
  if (!value || typeof value !== 'object') return null;
  const title = typeof value.title === 'string' ? value.title.trim().slice(0, 220) : '';
  const badge = typeof value.badge === 'string' ? value.badge.trim().slice(0, 40) : '';
  const subtitle = typeof value.subtitle === 'string' ? value.subtitle.trim().slice(0, 160) : '';
  const type = typeof value.type === 'string' ? value.type.trim().slice(0, 32) : '';
  const icon = typeof value.icon === 'string' ? value.icon.trim().slice(0, 48) : '';
  const color = typeof value.color === 'string' ? value.color.trim().slice(0, 32) : '';
  const bgTint = typeof value.bgTint === 'string' ? value.bgTint.trim().slice(0, 48) : '';
  const borderColor = typeof value.borderColor === 'string' ? value.borderColor.trim().slice(0, 48) : '';
  const fontStyleId = typeof value.fontStyleId === 'string' ? value.fontStyleId.trim().slice(0, 32) : '';
  const fontColor = typeof value.fontColor === 'string' && /^#[0-9a-f]{3,8}$/i.test(value.fontColor.trim())
    ? value.fontColor.trim()
    : '';
  const glowEffectId = typeof value.glowEffectId === 'string' ? value.glowEffectId.trim().slice(0, 32) : '';
  const rawMusic = value.music && typeof value.music === 'object' ? value.music : null;
  const music = rawMusic ? {
    title: typeof rawMusic.title === 'string' ? rawMusic.title.trim().slice(0, 160) : '',
    artist: typeof rawMusic.artist === 'string' ? rawMusic.artist.trim().slice(0, 160) : '',
    coverUrl: typeof rawMusic.coverUrl === 'string' ? rawMusic.coverUrl.trim().slice(0, 1_200) : '',
    coverColors: Array.isArray(rawMusic.coverColors)
      ? rawMusic.coverColors.filter((item) => typeof item === 'string').slice(0, 2).map((item) => item.trim().slice(0, 24))
      : [],
  } : null;
  return title || badge || subtitle || type || icon || color || bgTint || borderColor || fontStyleId || fontColor || glowEffectId || music?.title
    ? { title, badge, subtitle, type, icon, color, bgTint, borderColor, fontStyleId, fontColor, glowEffectId, music }
    : null;
}

async function persistMedia(file, userId, durationMs) {
  const isImage = IMAGE_MIME_TYPES.has(file.mimetype) || file.mimetype?.startsWith('image/');
  if (isImage) {
    if (file.size > MAX_IMAGE_BYTES) throw new Error('Ảnh tối đa 12 MB.');
    await mkdir(momentImageDirectory, { recursive: true });
    const filename = `moment-${userId}-${randomBytes(12).toString('hex')}.webp`;
    const destination = path.join(momentImageDirectory, filename);
    const image = sharp(file.buffer, { failOn: 'none', limitInputPixels: 36_000_000 }).rotate();
    const metadata = await image.metadata();
    await image.resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 90, effort: 4 }).toFile(destination);
    return {
      type: 'image',
      path: `/uploads/moments/images/${filename}`,
      mimeType: 'image/webp',
      filename,
      width: metadata.width || undefined,
      height: metadata.height || undefined,
    };
  }

  if (file.size > MAX_VIDEO_BYTES) throw new Error('Video tối đa 40 MB.');
  await mkdir(momentVideoDirectory, { recursive: true });
  const extension = path.extname(file.originalname || '').toLowerCase() || '.mp4';
  const filename = `moment-${userId}-${randomBytes(12).toString('hex')}${extension}`;
  await writeFile(path.join(momentVideoDirectory, filename), file.buffer);
  return {
    type: 'video',
    path: `/uploads/moments/videos/${filename}`,
    mimeType: file.mimetype || 'video/mp4',
    filename,
    durationMs: Number.isFinite(Number(durationMs)) ? Math.max(0, Math.round(Number(durationMs))) : undefined,
  };
}

async function removeLocalMoment(pathname) {
  if (!pathname?.startsWith('/uploads/moments/')) return;
  const folder = pathname.includes('/videos/') ? momentVideoDirectory : momentImageDirectory;
  await unlink(path.join(folder, path.basename(pathname))).catch(() => undefined);
}

function runMomentUpload(request, response, next) {
  const contentType = request.get('content-type') || '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return response.status(422).json({ code: 'MOMENT_MEDIA_REQUIRED', message: 'Vui lòng chọn ảnh hoặc video để đăng.' });
  }
  return momentUpload(request, response, (error) => {
    if (!error) return next();
    const tooLarge = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
    return response.status(tooLarge ? 413 : 422).json({
      code: tooLarge ? 'MOMENT_MEDIA_TOO_LARGE' : 'INVALID_MOMENT_MEDIA',
      message: tooLarge ? 'Video tối đa 40 MB, ảnh tối đa 12 MB.' : error.message || 'Tệp khoảnh khắc không hợp lệ.',
    });
  });
}

export function createMomentPostRouter({ isDatabaseReady, isUserOnline = () => false, emitPostEvent = () => undefined }) {
  const router = Router();

  router.get('/moments', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const before = new Date(String(request.query.before || ''));
      const limit = Math.max(1, Math.min(Number(request.query.limit) || 20, 40));
      const audience = [user._id, ...(user.friends || [])];
      const query = { author: { $in: audience } };
      if (Number.isFinite(before.getTime())) query.createdAt = { $lt: before };
      const rows = await MomentPost.find(query)
        .sort({ createdAt: -1 })
        .limit(limit + 1)
        .populate({ path: 'author', select: 'fullName username avatarPath lastActiveAt' });
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      return response.json({ posts: rows.map((post) => postPayload(post, isUserOnline)), hasMore });
    } catch (error) {
      console.error('Get moments failed:', error);
      return response.status(500).json({ code: 'GET_MOMENTS_FAILED', message: 'Không thể tải khoảnh khắc lúc này.' });
    }
  });

  router.post('/moments', runMomentUpload, async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    let savedPath = '';
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      if (!request.file) return response.status(422).json({ code: 'MOMENT_MEDIA_REQUIRED', message: 'Vui lòng chọn ảnh hoặc video để đăng.' });

      const media = await persistMedia(request.file, user._id.toString(), request.body?.durationMs);
      savedPath = media.path;
      const post = await MomentPost.create({
        author: user._id,
        media,
        caption: typeof request.body?.caption === 'string' ? request.body.caption.trim().slice(0, 500) : '',
        stickers: sanitizeStickers(parseJsonField(request.body?.stickers, [])),
        widget: sanitizeWidget(parseJsonField(request.body?.widget, null)),
      });
      await post.populate({ path: 'author', select: 'fullName username avatarPath lastActiveAt' });
      const payload = postPayload(post, isUserOnline);
      const recipients = new Set([user._id.toString(), ...(user.friends || []).map((id) => id.toString())]);
      for (const recipientId of recipients) emitPostEvent(recipientId, 'moment:new', { post: payload });
      return response.status(201).json({ post: payload });
    } catch (error) {
      if (savedPath) await removeLocalMoment(savedPath);
      console.error('Create moment failed:', error);
      return response.status(500).json({ code: 'CREATE_MOMENT_FAILED', message: error.message || 'Không thể đăng khoảnh khắc lúc này.' });
    }
  });

  router.post('/moments/:postId/view', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      if (!mongoose.isValidObjectId(request.params.postId)) {
        return response.status(404).json({ code: 'MOMENT_NOT_FOUND', message: 'Không tìm thấy khoảnh khắc.' });
      }
      const post = await MomentPost.findById(request.params.postId).select('author views');
      if (!post) return response.status(404).json({ code: 'MOMENT_NOT_FOUND', message: 'Không tìm thấy khoảnh khắc.' });

      const isAuthor = post.author.toString() === user._id.toString();
      const isFriend = (user.friends || []).some((friendId) => friendId.toString() === post.author.toString());
      if (!isAuthor && !isFriend) {
        return response.status(403).json({ code: 'MOMENT_ACCESS_DENIED', message: 'Bạn không có quyền xem khoảnh khắc này.' });
      }
      const viewedAt = new Date();
      let recordedNewView = false;
      if (!isAuthor) {
        const updateResult = await MomentPost.updateOne(
          { _id: post._id, 'views.user': { $ne: user._id } },
          { $push: { views: { user: user._id, viewedAt } } },
        );
        recordedNewView = updateResult.modifiedCount > 0;
      }
      const updated = await MomentPost.findById(post._id).select('views');
      const viewCount = updated?.views?.length || 0;
      if (recordedNewView) {
        emitPostEvent(post.author.toString(), 'moment:view', {
          postId: post._id.toString(),
          viewer: userPayload(user, isUserOnline),
          viewedAt: viewedAt.toISOString(),
          viewCount,
        });
      }
      return response.json({ viewCount });
    } catch (error) {
      console.error('Record moment view failed:', error);
      return response.status(500).json({ code: 'RECORD_MOMENT_VIEW_FAILED', message: 'Không thể ghi nhận lượt xem lúc này.' });
    }
  });

  router.get('/moments/:postId/views', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      if (!mongoose.isValidObjectId(request.params.postId)) {
        return response.status(404).json({ code: 'MOMENT_NOT_FOUND', message: 'Không tìm thấy khoảnh khắc.' });
      }
      const post = await MomentPost.findById(request.params.postId)
        .select('author views')
        .populate({ path: 'views.user', select: 'fullName username avatarPath lastActiveAt' });
      if (!post) return response.status(404).json({ code: 'MOMENT_NOT_FOUND', message: 'Không tìm thấy khoảnh khắc.' });
      if (post.author.toString() !== user._id.toString()) {
        return response.status(403).json({ code: 'MOMENT_VIEWS_FORBIDDEN', message: 'Chỉ tác giả mới xem được hoạt động của bài đăng.' });
      }
      const viewers = (post.views || [])
        .filter((entry) => entry.user?.fullName)
        .sort((first, second) => new Date(second.viewedAt).getTime() - new Date(first.viewedAt).getTime())
        .map((entry) => ({ viewer: userPayload(entry.user, isUserOnline), viewedAt: new Date(entry.viewedAt).toISOString() }));
      return response.json({ viewers });
    } catch (error) {
      console.error('Get moment viewers failed:', error);
      return response.status(500).json({ code: 'GET_MOMENT_VIEWERS_FAILED', message: 'Không thể tải hoạt động bạn bè lúc này.' });
    }
  });

  return router;
}
