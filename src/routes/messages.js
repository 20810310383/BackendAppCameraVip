import { randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import sharp from 'sharp';
import { ConversationAppearance } from '../models/ConversationAppearance.js';
import { Message } from '../models/Message.js';
import { MomentPost } from '../models/MomentPost.js';
import { Session } from '../models/Session.js';
import { User } from '../models/User.js';
import { canUsersMessage, conversationKeyFor, messageAccessStatus } from '../services/message-service.js';
import { deleteStoredObject, storeProcessedFile } from '../services/object-storage-service.js';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  getNotificationPreferences,
  getRecipientBadgeCount,
  isExpoPushToken,
  sendChatPushNotification,
} from '../services/push-service.js';
import { hashSessionToken } from '../services/session-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const messageUploadDirectory = path.resolve(__dirname, '../../uploads/messages');
const messageImageDirectory = path.join(messageUploadDirectory, 'images');
const messageAudioDirectory = path.join(messageUploadDirectory, 'audio');
const conversationWallpaperDirectory = path.resolve(__dirname, '../../uploads/conversation-wallpapers');
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic', 'image/heif']);
const AUDIO_MIME_TYPES = new Set([
  'audio/aac',
  'audio/x-aac',
  'audio/m4a',
  'audio/x-m4a',
  'audio/mp4',
  'audio/mp4a-latm',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/webm',
  'audio/wav',
  'audio/x-wav',
  'audio/3gpp',
  'audio/3gp',
  'audio/amr',
  'application/octet-stream',
  'video/mp4',
]);

const messageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES, files: 1 },
  fileFilter: (_request, file, callback) => {
    const isImage =
      file.fieldname === 'image' &&
      (IMAGE_MIME_TYPES.has(file.mimetype) || file.mimetype?.startsWith('image/'));
    const isAudio =
      file.fieldname === 'audio' &&
      (file.mimetype?.startsWith('audio/') ||
        AUDIO_MIME_TYPES.has(file.mimetype) ||
        /\.(m4a|mp3|aac|wav|ogg|webm|3gp|mp4)$/i.test(file.originalname));

    if (isImage || isAudio) {
      callback(null, true);
      return;
    }
    callback(new Error('Tệp đính kèm không được hỗ trợ.'));
  },
}).fields([
  { name: 'image', maxCount: 1 },
  { name: 'audio', maxCount: 1 },
]);

const conversationWallpaperUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (_request, file, callback) => {
    const supported = file.fieldname === 'wallpaper'
      && (IMAGE_MIME_TYPES.has(file.mimetype) || file.mimetype?.startsWith('image/'));
    if (supported) {
      callback(null, true);
      return;
    }
    callback(new Error('Chỉ hỗ trợ ảnh làm hình nền cuộc trò chuyện.'));
  },
}).single('wallpaper');

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
  const user = await User.findById(session.userId).select('+notificationPreferences');
  if (!user) {
    response.status(401).json({ code: 'SESSION_INVALID', message: 'Tài khoản không còn tồn tại.' });
    return null;
  }
  return user;
}

function userSummary(user, isUserOnline) {
  const isOnline = Boolean(isUserOnline(user._id));
  return {
    id: user.id || user._id.toString(),
    fullName: user.fullName,
    username: user.username,
    avatarPath: user.avatarPath || '',
    isOnline,
    lastActiveAt: user.lastActiveAt ? user.lastActiveAt.toISOString() : null,
    activityLabel: isOnline ? 'Đang hoạt động' : 'Ngoại tuyến',
  };
}

function replyToPayload(replyTo, isUserOnline) {
  if (!replyTo) return null;
  const plain = typeof replyTo.toObject === 'function' ? replyTo.toObject() : replyTo;
  if (!plain._id && !plain.id) return null;
  const sender = plain.sender?.fullName ? userSummary(plain.sender, isUserOnline) : plain.sender;
  const isRevoked = Boolean(plain.revokedAt);
  let textPreview = isRevoked ? 'Tin nhắn đã bị thu hồi' : (plain.text || '');
  if (!isRevoked && !textPreview) {
    if (plain.type === 'image') textPreview = '📷 Hình ảnh';
    else if (plain.type === 'audio') textPreview = '🎤 Tin nhắn thoại';
  }
  return {
    id: plain._id?.toString() || plain.id,
    sender: sender ? { id: sender.id || sender._id?.toString(), fullName: sender.fullName || '' } : null,
    text: textPreview,
    type: plain.type || 'text',
    isRevoked,
  };
}

function messagePayload(message, isUserOnline) {
  const plain = typeof message.toObject === 'function' ? message.toObject() : message;
  const sender = plain.sender?.fullName ? userSummary(plain.sender, isUserOnline) : plain.sender;
  const recipient = plain.recipient?.fullName ? userSummary(plain.recipient, isUserOnline) : plain.recipient;
  const isRevoked = Boolean(plain.revokedAt);
  return {
    id: plain._id?.toString() || plain.id,
    conversationKey: plain.conversationKey,
    sender,
    recipient,
    type: plain.type,
    text: isRevoked ? 'Tin nhắn đã bị thu hồi' : (plain.text || ''),
    attachment: isRevoked ? null : (plain.attachment || null),
    momentReply: isRevoked ? null : (plain.momentReply || null),
    replyTo: replyToPayload(plain.replyTo, isUserOnline),
    deliveredAt: plain.deliveredAt ? new Date(plain.deliveredAt).toISOString() : null,
    readAt: plain.readAt ? new Date(plain.readAt).toISOString() : null,
    isRevoked,
    revokedAt: plain.revokedAt ? new Date(plain.revokedAt).toISOString() : null,
    createdAt: new Date(plain.createdAt).toISOString(),
  };
}

function conversationWallpaperPayload(appearance) {
  const wallpaper = appearance?.wallpaper;
  if (!wallpaper?.path) return null;
  return {
    path: wallpaper.path,
    mimeType: wallpaper.mimeType || 'image/webp',
    filename: wallpaper.filename || path.basename(wallpaper.path),
    width: wallpaper.width || undefined,
    height: wallpaper.height || undefined,
    updatedAt: wallpaper.updatedAt ? new Date(wallpaper.updatedAt).toISOString() : null,
  };
}

async function populateMessage(message) {
  return message.populate([
    { path: 'sender', select: 'fullName username avatarPath lastActiveAt' },
    { path: 'recipient', select: 'fullName username avatarPath lastActiveAt' },
    {
      path: 'replyTo',
      select: 'sender text type attachment revokedAt',
      populate: { path: 'sender', select: 'fullName username' },
    },
  ]);
}

async function removeLocalAttachment(attachmentPath) {
  if (await deleteStoredObject(attachmentPath)) return;
  if (!attachmentPath?.startsWith('/uploads/messages/')) return;
  await unlink(path.join(messageUploadDirectory, path.basename(path.dirname(attachmentPath)), path.basename(attachmentPath))).catch(() => undefined);
}

async function removeLocalConversationWallpaper(wallpaperPath) {
  if (await deleteStoredObject(wallpaperPath)) return;
  if (!wallpaperPath?.startsWith('/uploads/conversation-wallpapers/')) return;
  await unlink(path.join(conversationWallpaperDirectory, path.basename(wallpaperPath))).catch(() => undefined);
}

async function persistImage(file, userId) {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Ảnh tối đa 12 MB.');
  await mkdir(messageImageDirectory, { recursive: true });
  const filename = `image-${userId}-${randomBytes(12).toString('hex')}.webp`;
  const destination = path.join(messageImageDirectory, filename);
  const image = sharp(file.buffer, { failOn: 'none', limitInputPixels: 36_000_000 }).rotate();
  const metadata = await image.metadata();
  await image.resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 95, effort: 4 }).toFile(destination);
  return {
    path: await storeProcessedFile({
      localPath: destination,
      localUrl: `/uploads/messages/images/${filename}`,
      objectKey: `media/messages/images/${filename}`,
      contentType: 'image/webp',
    }),
    mimeType: 'image/webp',
    filename,
    width: metadata.width || undefined,
    height: metadata.height || undefined,
  };
}

async function persistConversationWallpaper(file, userId) {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Hình nền tối đa 12 MB.');
  await mkdir(conversationWallpaperDirectory, { recursive: true });
  const filename = `wallpaper-${userId}-${randomBytes(12).toString('hex')}.webp`;
  const destination = path.join(conversationWallpaperDirectory, filename);
  const image = sharp(file.buffer, { failOn: 'none', limitInputPixels: 36_000_000 }).rotate();
  const metadata = await image.metadata();
  await image
    .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 88, effort: 4 })
    .toFile(destination);
  return {
    path: await storeProcessedFile({
      localPath: destination,
      localUrl: `/uploads/conversation-wallpapers/${filename}`,
      objectKey: `media/conversation-wallpapers/${filename}`,
      contentType: 'image/webp',
    }),
    mimeType: 'image/webp',
    filename,
    width: metadata.width || undefined,
    height: metadata.height || undefined,
    updatedBy: userId,
  };
}

function audioExtension(mimeType, originalName = '') {
  if (originalName && path.extname(originalName)) return path.extname(originalName).toLowerCase();
  if (mimeType === 'audio/webm') return '.webm';
  if (mimeType === 'audio/ogg') return '.ogg';
  if (mimeType === 'audio/wav' || mimeType === 'audio/x-wav') return '.wav';
  if (mimeType === 'audio/3gpp' || mimeType === 'audio/3gp') return '.3gp';
  if (mimeType === 'audio/mpeg' || mimeType === 'audio/mp3') return '.mp3';
  if (mimeType === 'audio/aac' || mimeType === 'audio/x-aac') return '.aac';
  return '.m4a';
}

function normalizedAudioMimeType(value) {
  const mimeType = typeof value === 'string' ? value.trim().toLowerCase() : '';
  // M4A is an MP4 audio container. `audio/mp4` is the interoperable MIME type
  // understood by iOS AVFoundation, Android Media3 and Cloudflare R2 clients.
  if (mimeType === 'audio/m4a' || mimeType === 'audio/x-m4a' || mimeType === 'audio/mp4a-latm') return 'audio/mp4';
  return mimeType || 'audio/mp4';
}

async function persistAudio(file, userId, durationMs) {
  if (file.size > MAX_AUDIO_BYTES) throw new Error('Tin nhắn thoại tối đa 20 MB.');
  const mimeType = normalizedAudioMimeType(file.mimetype);
  await mkdir(messageAudioDirectory, { recursive: true });
  const filename = `voice-${userId}-${randomBytes(12).toString('hex')}${audioExtension(mimeType, file.originalname)}`;
  const localPath = path.join(messageAudioDirectory, filename);
  await writeFile(localPath, file.buffer);
  return {
    path: await storeProcessedFile({
      localPath,
      localUrl: `/uploads/messages/audio/${filename}`,
      objectKey: `media/messages/audio/${filename}`,
      contentType: mimeType,
    }),
    mimeType,
    filename,
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : undefined,
  };
}

function runMessageUpload(request, response, next) {
  const contentType = request.get('content-type') || '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return next();
  }
  messageUpload(request, response, (error) => {
    if (!error) return next();
    const tooLarge = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
    return response.status(tooLarge ? 413 : 422).json({
      code: tooLarge ? 'ATTACHMENT_TOO_LARGE' : 'INVALID_ATTACHMENT',
      message: tooLarge ? 'Tệp đính kèm quá lớn.' : error.message || 'Tệp đính kèm không hợp lệ.',
    });
  });
}

function runConversationWallpaperUpload(request, response, next) {
  const contentType = request.get('content-type') || '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return response.status(422).json({ code: 'WALLPAPER_REQUIRED', message: 'Vui lòng chọn ảnh hình nền.' });
  }
  return conversationWallpaperUpload(request, response, (error) => {
    if (!error) return next();
    const tooLarge = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
    return response.status(tooLarge ? 413 : 422).json({
      code: tooLarge ? 'WALLPAPER_TOO_LARGE' : 'INVALID_WALLPAPER',
      message: tooLarge ? 'Hình nền tối đa 12 MB.' : error.message || 'Hình nền không hợp lệ.',
    });
  });
}

function requestLimit(value, fallback = 40) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), 80));
}

async function requireConversationUser(user, friendId, response) {
  if (!mongoose.isValidObjectId(friendId)) {
    response.status(404).json({ code: 'USER_NOT_FOUND', message: 'Không tìm thấy người bạn này.' });
    return null;
  }
  const friend = await User.findById(friendId);
  if (!friend) {
    response.status(404).json({ code: 'USER_NOT_FOUND', message: 'Không tìm thấy người bạn này.' });
    return null;
  }
  const accessStatus = messageAccessStatus(user, friend);
  if (accessStatus === 'blocked') {
    response.status(403).json({
      code: 'CONVERSATION_BLOCKED',
      message: 'Không thể nhắn tin vì một trong hai người đã chặn người còn lại.',
    });
    return null;
  }
  if (accessStatus !== 'available') {
    response.status(403).json({
      code: 'CONVERSATION_REQUIRES_FRIENDSHIP',
      message: 'Bạn cần kết bạn với người này trước khi nhắn tin.',
    });
    return null;
  }
  return friend;
}

async function markConversationRead({ user, friend, emitMessageEvent }) {
  const key = conversationKeyFor(user._id, friend._id);
  const unreadMessages = await Message.find({
    conversationKey: key,
    sender: friend._id,
    recipient: user._id,
    deletedFor: { $ne: user._id },
    readAt: null,
  }).select('_id');
  if (!unreadMessages.length) return null;

  const readAt = new Date();
  const messageIds = unreadMessages.map((message) => message._id.toString());
  await Message.updateMany({ _id: { $in: unreadMessages.map((message) => message._id) } }, { $set: { readAt } });
  emitMessageEvent(friend._id, 'message:read', {
    conversationKey: key,
    byUserId: user._id.toString(),
    messageIds,
    readAt: readAt.toISOString(),
  });
  return { messageIds, readAt };
}

export function createMessageRouter({
  isDatabaseReady,
  isUserOnline = () => false,
  emitMessageEvent = () => undefined,
}) {
  const router = Router();

  router.get('/notifications/badge-count', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const badgeCount = await getRecipientBadgeCount(user._id);
      return response.json({ badgeCount });
    } catch (error) {
      console.error('Get notification badge count failed:', error);
      return response.status(500).json({ code: 'GET_BADGE_COUNT_FAILED', message: 'Không thể tải số thông báo chưa xem.' });
    }
  });

  router.get('/notifications/preferences', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      return response.json({ preferences: getNotificationPreferences(user) });
    } catch (error) {
      console.error('Get notification preferences failed:', error);
      return response.status(500).json({ code: 'GET_NOTIFICATION_PREFERENCES_FAILED', message: 'Không thể tải cài đặt thông báo.' });
    }
  });

  router.patch('/notifications/preferences', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const requested = request.body?.preferences;
      if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
        return response.status(422).json({ code: 'INVALID_NOTIFICATION_PREFERENCES', message: 'Cài đặt thông báo không hợp lệ.' });
      }

      const changes = {};
      for (const key of Object.keys(DEFAULT_NOTIFICATION_PREFERENCES)) {
        if (requested[key] === undefined) continue;
        if (typeof requested[key] !== 'boolean') {
          return response.status(422).json({ code: 'INVALID_NOTIFICATION_PREFERENCES', message: 'Mỗi lựa chọn thông báo phải là bật hoặc tắt.' });
        }
        changes[key] = requested[key];
      }
      if (!Object.keys(changes).length) {
        return response.status(422).json({ code: 'INVALID_NOTIFICATION_PREFERENCES', message: 'Chưa có lựa chọn thông báo nào để cập nhật.' });
      }

      user.notificationPreferences = { ...getNotificationPreferences(user), ...changes };
      await user.save();
      return response.json({ preferences: getNotificationPreferences(user) });
    } catch (error) {
      console.error('Update notification preferences failed:', error);
      return response.status(500).json({ code: 'UPDATE_NOTIFICATION_PREFERENCES_FAILED', message: 'Không thể lưu cài đặt thông báo.' });
    }
  });

  router.put('/notifications/push-token', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const token = typeof request.body?.token === 'string' ? request.body.token.trim() : '';
      const platform = request.body?.platform === 'ios' ? 'ios' : request.body?.platform === 'android' ? 'android' : '';
      if (!isExpoPushToken(token) || !platform) {
        return response.status(422).json({ code: 'INVALID_PUSH_TOKEN', message: 'Push token hoặc nền tảng không hợp lệ.' });
      }

      const tokens = (user.expoPushTokens || []).filter((entry) => entry.token !== token);
      tokens.push({ token, platform, updatedAt: new Date() });
      user.expoPushTokens = tokens.slice(-8);
      await user.save();
      return response.json({ ok: true });
    } catch (error) {
      console.error('Register push token failed:', error);
      return response.status(500).json({ code: 'REGISTER_PUSH_TOKEN_FAILED', message: 'Không thể đăng ký thông báo cho thiết bị này.' });
    }
  });

  router.delete('/notifications/push-token', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const token = typeof request.body?.token === 'string' ? request.body.token.trim() : '';
      if (token) {
        user.expoPushTokens = (user.expoPushTokens || []).filter((entry) => entry.token !== token);
        await user.save();
      }
      return response.json({ ok: true });
    } catch (error) {
      console.error('Remove push token failed:', error);
      return response.status(500).json({ code: 'REMOVE_PUSH_TOKEN_FAILED', message: 'Không thể gỡ thông báo khỏi thiết bị này.' });
    }
  });

  router.get('/messages/conversations', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const rows = await Message.aggregate([
        { $match: { participants: user._id, deletedFor: { $ne: user._id } } },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: '$conversationKey',
            latest: { $first: '$$ROOT' },
            unreadCount: {
              $sum: {
                $cond: [{ $and: [{ $eq: ['$recipient', user._id] }, { $eq: ['$readAt', null] }] }, 1, 0],
              },
            },
          },
        },
        { $sort: { 'latest.createdAt': -1 } },
      ]);
      await Message.populate(rows, [
        { path: 'latest.sender', model: User, select: 'fullName username avatarPath lastActiveAt friends blockedUsers' },
        { path: 'latest.recipient', model: User, select: 'fullName username avatarPath lastActiveAt friends blockedUsers' },
      ]);
      const candidates = rows.flatMap((row) => {
        const latest = messagePayload(row.latest, isUserOnline);
        if (!latest.sender?.id || !latest.recipient?.id) {
          console.warn(`Skipping orphaned message conversation ${row._id}: sender or recipient no longer exists.`);
          return [];
        }
        const currentUserId = user._id.toString();
        if (latest.sender.id !== currentUserId && latest.recipient.id !== currentUserId) {
          console.warn(`Skipping inaccessible message conversation ${row._id}.`);
          return [];
        }
        const friend = latest.sender.id === currentUserId ? latest.recipient : latest.sender;
        const friendDocument = latest.sender.id === currentUserId ? row.latest.recipient : row.latest.sender;
        return [{
          id: row._id,
          friend,
          latestMessage: latest,
          unreadCount: row.unreadCount,
          updatedAt: latest.createdAt,
          messagingStatus: messageAccessStatus(user, friendDocument),
        }];
      });
      return response.json({ conversations: candidates });
    } catch (error) {
      console.error('Get conversations failed:', error);
      return response.status(500).json({ code: 'GET_CONVERSATIONS_FAILED', message: 'Không thể tải hội thoại lúc này.' });
    }
  });

  router.get('/messages/conversations/:friendId/media', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const friend = await requireConversationUser(user, request.params.friendId, response);
      if (!friend) return;

      const before = new Date(String(request.query.before || ''));
      const query = {
        conversationKey: conversationKeyFor(user._id, friend._id),
        deletedFor: { $ne: user._id },
        type: 'image',
        'attachment.path': { $exists: true },
      };
      if (Number.isFinite(before.getTime())) query.createdAt = { $lt: before };
      const limit = requestLimit(request.query.limit, 60);
      const rows = await Message.find(query)
        .sort({ createdAt: -1 })
        .limit(limit + 1)
        .populate([
          { path: 'sender', select: 'fullName username avatarPath lastActiveAt' },
          { path: 'recipient', select: 'fullName username avatarPath lastActiveAt' },
        ]);
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      return response.json({
        images: rows.map((message) => messagePayload(message, isUserOnline)),
        hasMore,
      });
    } catch (error) {
      console.error('Get conversation media failed:', error);
      return response.status(500).json({ code: 'GET_CONVERSATION_MEDIA_FAILED', message: 'Không thể tải ảnh trong cuộc trò chuyện lúc này.' });
    }
  });

  router.put('/messages/conversations/:friendId/wallpaper', runConversationWallpaperUpload, async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    let savedWallpaperPath = '';
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const friend = await requireConversationUser(user, request.params.friendId, response);
      if (!friend) return;
      if (!request.file) {
        return response.status(422).json({ code: 'WALLPAPER_REQUIRED', message: 'Vui lòng chọn ảnh hình nền.' });
      }

      const key = conversationKeyFor(user._id, friend._id);
      const previous = await ConversationAppearance.findOne({ conversationKey: key });
      const wallpaper = await persistConversationWallpaper(request.file, user._id.toString());
      savedWallpaperPath = wallpaper.path;
      const appearance = await ConversationAppearance.findOneAndUpdate(
        { conversationKey: key },
        {
          $set: {
            participants: [user._id, friend._id],
            wallpaper,
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true },
      );
      if (previous?.wallpaper?.path && previous.wallpaper.path !== wallpaper.path) {
        await removeLocalConversationWallpaper(previous.wallpaper.path);
      }

      const payload = conversationWallpaperPayload(appearance);
      emitMessageEvent(user._id, 'conversation:wallpaper-updated', {
        conversationKey: key,
        friendId: friend._id.toString(),
        wallpaper: payload,
      });
      emitMessageEvent(friend._id, 'conversation:wallpaper-updated', {
        conversationKey: key,
        friendId: user._id.toString(),
        wallpaper: payload,
      });
      return response.json({ wallpaper: payload });
    } catch (error) {
      if (savedWallpaperPath) await removeLocalConversationWallpaper(savedWallpaperPath);
      console.error('Update conversation wallpaper failed:', error);
      return response.status(500).json({ code: 'UPDATE_CONVERSATION_WALLPAPER_FAILED', message: 'Không thể cập nhật hình nền cuộc trò chuyện lúc này.' });
    }
  });

  router.delete('/messages/conversations/:friendId/wallpaper', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const friend = await requireConversationUser(user, request.params.friendId, response);
      if (!friend) return;

      const key = conversationKeyFor(user._id, friend._id);
      const appearance = await ConversationAppearance.findOneAndDelete({ conversationKey: key });
      if (appearance?.wallpaper?.path) await removeLocalConversationWallpaper(appearance.wallpaper.path);

      emitMessageEvent(user._id, 'conversation:wallpaper-updated', {
        conversationKey: key,
        friendId: friend._id.toString(),
        wallpaper: null,
      });
      emitMessageEvent(friend._id, 'conversation:wallpaper-updated', {
        conversationKey: key,
        friendId: user._id.toString(),
        wallpaper: null,
      });
      return response.json({ wallpaper: null });
    } catch (error) {
      console.error('Remove conversation wallpaper failed:', error);
      return response.status(500).json({ code: 'REMOVE_CONVERSATION_WALLPAPER_FAILED', message: 'Không thể gỡ hình nền cuộc trò chuyện lúc này.' });
    }
  });

  router.get('/messages/conversations/:friendId', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const friend = await requireConversationUser(user, request.params.friendId, response);
      if (!friend) return;
      // Reading state is not needed to render the conversation. Do it in the background
      // so opening a chat is not delayed by an extra find + update round-trip to MongoDB.
      void markConversationRead({ user, friend, emitMessageEvent })
        .catch((error) => console.warn(`Mark message read in background failed: ${error.message}`));
      const key = conversationKeyFor(user._id, friend._id);
      const before = new Date(String(request.query.before || ''));
      const query = { conversationKey: key, deletedFor: { $ne: user._id } };
      if (Number.isFinite(before.getTime())) query.createdAt = { $lt: before };
      const limit = requestLimit(request.query.limit);
      const [rows, appearance] = await Promise.all([
        Message.find(query)
          .sort({ createdAt: -1 })
          .limit(limit + 1)
          .populate([
            { path: 'sender', select: 'fullName username avatarPath lastActiveAt' },
            { path: 'recipient', select: 'fullName username avatarPath lastActiveAt' },
            {
              path: 'replyTo',
              select: 'sender text type attachment revokedAt',
              populate: { path: 'sender', select: 'fullName username' },
            },
          ]),
        ConversationAppearance.findOne({ conversationKey: key }),
      ]);
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      return response.json({
        friend: userSummary(friend, isUserOnline),
        messages: rows.reverse().map((message) => messagePayload(message, isUserOnline)),
        hasMore,
        wallpaper: conversationWallpaperPayload(appearance),
      });
    } catch (error) {
      console.error('Get conversation failed:', error);
      return response.status(500).json({ code: 'GET_CONVERSATION_FAILED', message: 'Không thể tải tin nhắn lúc này.' });
    }
  });

  router.get('/messages/conversations/:friendId/messages/:messageId', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const friend = await requireConversationUser(user, request.params.friendId, response);
      if (!friend) return;
      if (!mongoose.isValidObjectId(request.params.messageId)) {
        return response.status(404).json({ code: 'MESSAGE_NOT_FOUND', message: 'Không tìm thấy tin nhắn gốc.' });
      }

      const key = conversationKeyFor(user._id, friend._id);
      const visibleMessageQuery = { conversationKey: key, deletedFor: { $ne: user._id } };
      const target = await Message.findOne({ ...visibleMessageQuery, _id: request.params.messageId });
      if (!target) {
        return response.status(404).json({ code: 'MESSAGE_NOT_FOUND', message: 'Tin nhắn gốc không còn trong cuộc trò chuyện của bạn.' });
      }

      const [newer, older, hasMoreOlder] = await Promise.all([
        Message.find({ ...visibleMessageQuery, createdAt: { $gt: target.createdAt } })
          .sort({ createdAt: 1 })
          .limit(20),
        Message.find({ ...visibleMessageQuery, createdAt: { $lt: target.createdAt } })
          .sort({ createdAt: -1 })
          .limit(20),
        Message.exists({ ...visibleMessageQuery, createdAt: { $lt: target.createdAt } }),
      ]);
      const rows = [...newer, target, ...older]
        .sort((first, second) => first.createdAt.getTime() - second.createdAt.getTime());
      await Message.populate(rows, [
        { path: 'sender', select: 'fullName username avatarPath lastActiveAt' },
        { path: 'recipient', select: 'fullName username avatarPath lastActiveAt' },
        {
          path: 'replyTo',
          select: 'sender text type attachment revokedAt',
          populate: { path: 'sender', select: 'fullName username' },
        },
      ]);
      return response.json({
        friend: userSummary(friend, isUserOnline),
        messages: rows.map((message) => messagePayload(message, isUserOnline)),
        hasMore: Boolean(hasMoreOlder),
      });
    } catch (error) {
      console.error('Get message context failed:', error);
      return response.status(500).json({ code: 'GET_MESSAGE_CONTEXT_FAILED', message: 'Không thể mở tin nhắn được trích dẫn lúc này.' });
    }
  });

  router.delete('/messages/conversations/:friendId', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const friendId = request.params.friendId;
      if (!mongoose.isValidObjectId(friendId)) {
        return response.status(404).json({ code: 'USER_NOT_FOUND', message: 'Không tìm thấy người dùng này.' });
      }
      const key = conversationKeyFor(user._id, friendId);
      await Message.updateMany(
        { conversationKey: key, participants: user._id },
        { $addToSet: { deletedFor: user._id } }
      );
      return response.json({ ok: true });
    } catch (error) {
      console.error('Delete conversation failed:', error);
      return response.status(500).json({ code: 'DELETE_CONVERSATION_FAILED', message: 'Không thể xóa cuộc trò chuyện lúc này.' });
    }
  });

  router.delete('/messages/item/:messageId', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const { messageId } = request.params;
      if (!mongoose.isValidObjectId(messageId)) {
        return response.status(404).json({ code: 'MESSAGE_NOT_FOUND', message: 'Không tìm thấy tin nhắn.' });
      }
      const message = await Message.findOne({ _id: messageId, participants: user._id });
      if (!message) {
        return response.status(404).json({ code: 'MESSAGE_NOT_FOUND', message: 'Không tìm thấy tin nhắn.' });
      }
      message.deletedFor = message.deletedFor || [];
      if (!message.deletedFor.some((id) => id.equals(user._id))) {
        message.deletedFor.push(user._id);
        await message.save();
      }
      return response.json({ ok: true, messageId });
    } catch (error) {
      console.error('Delete message failed:', error);
      return response.status(500).json({ code: 'DELETE_MESSAGE_FAILED', message: 'Không thể xóa tin nhắn lúc này.' });
    }
  });

  router.post('/messages/item/:messageId/revoke', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const { messageId } = request.params;
      if (!mongoose.isValidObjectId(messageId)) {
        return response.status(404).json({ code: 'MESSAGE_NOT_FOUND', message: 'Không tìm thấy tin nhắn.' });
      }
      const message = await Message.findOne({ _id: messageId, participants: user._id });
      if (!message) {
        return response.status(404).json({ code: 'MESSAGE_NOT_FOUND', message: 'Không tìm thấy tin nhắn.' });
      }
      if (message.sender.toString() !== user._id.toString()) {
        return response.status(403).json({ code: 'REVOKE_FORBIDDEN', message: 'Bạn chỉ có thể thu hồi tin nhắn do chính bạn gửi.' });
      }
      if (message.revokedAt) {
        await populateMessage(message);
        return response.json({ message: messagePayload(message, isUserOnline) });
      }

      const attachmentPath = message.attachment?.path;
      message.revokedAt = new Date();
      message.text = '';
      message.attachment = undefined;
      await message.save();

      if (attachmentPath) {
        await removeLocalAttachment(attachmentPath);
      }

      await populateMessage(message);
      const payload = messagePayload(message, isUserOnline);

      const recipientId = message.recipient?.id || message.recipient?._id?.toString() || message.recipient?.toString();
      emitMessageEvent(recipientId, 'message:revoked', { message: payload, messageId: payload.id });
      emitMessageEvent(user._id, 'message:revoked', { message: payload, messageId: payload.id });

      return response.json({ message: payload });
    } catch (error) {
      console.error('Revoke message failed:', error);
      return response.status(500).json({ code: 'REVOKE_MESSAGE_FAILED', message: 'Không thể thu hồi tin nhắn lúc này.' });
    }
  });

  router.post('/messages/conversations/:friendId/read', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const friend = await requireConversationUser(user, request.params.friendId, response);
      if (!friend) return;
      const result = await markConversationRead({ user, friend, emitMessageEvent });
      return response.json({ readAt: result?.readAt?.toISOString() || null, messageIds: result?.messageIds || [] });
    } catch (error) {
      console.error('Mark conversation read failed:', error);
      return response.status(500).json({ code: 'MARK_CONVERSATION_READ_FAILED', message: 'Không thể cập nhật trạng thái đã xem.' });
    }
  });

  router.post('/messages/conversations/:friendId', runMessageUpload, async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    let savedAttachmentPath = '';
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const friend = await requireConversationUser(user, request.params.friendId, response);
      if (!friend) return;

      const files = request.files || {};
      const imageFile = Array.isArray(files.image) ? files.image[0] : null;
      const audioFile = Array.isArray(files.audio) ? files.audio[0] : null;
      if (imageFile && audioFile) {
        return response.status(422).json({ code: 'TOO_MANY_ATTACHMENTS', message: 'Mỗi tin nhắn chỉ gửi được một tệp.' });
      }
      const text = typeof request.body?.text === 'string' ? request.body.text.trim() : '';
      if (text.length > 2000) {
        return response.status(422).json({ code: 'MESSAGE_TOO_LONG', message: 'Tin nhắn không được vượt quá 2.000 ký tự.' });
      }
      if (!text && !imageFile && !audioFile) {
        return response.status(422).json({ code: 'EMPTY_MESSAGE', message: 'Hãy nhập tin nhắn hoặc chọn tệp đính kèm.' });
      }

      const lastSent = await Message.findOne({ sender: user._id }).sort({ createdAt: -1 }).select('createdAt');
      if (lastSent && Date.now() - lastSent.createdAt.getTime() < 300) {
        return response.status(429).json({ code: 'MESSAGE_RATE_LIMITED', message: 'Bạn gửi tin nhắn quá nhanh. Vui lòng thử lại sau một chút.' });
      }

      let type = request.body?.type === 'emoji' && text && !imageFile && !audioFile ? 'emoji' : 'text';
      let attachment;
      if (imageFile) {
        type = 'image';
        attachment = await persistImage(imageFile, user._id);
        savedAttachmentPath = attachment.path;
      } else if (audioFile) {
        type = 'audio';
        attachment = await persistAudio(audioFile, user._id, Number(request.body?.durationMs));
        savedAttachmentPath = attachment.path;
      }

      let replyTo = null;
      const replyToMessageId = request.body?.replyToMessageId || request.body?.replyToId;
      if (replyToMessageId && mongoose.isValidObjectId(replyToMessageId)) {
        const parentMsg = await Message.findOne({
          _id: replyToMessageId,
          participants: user._id,
        });
        if (parentMsg) {
          replyTo = parentMsg._id;
        }
      }

      let momentReply = null;
      const momentPostId = request.body?.momentPostId;
      if (momentPostId) {
        if (!mongoose.isValidObjectId(momentPostId)) {
          return response.status(422).json({ code: 'INVALID_MOMENT_REPLY', message: 'Khoảnh khắc được trả lời không hợp lệ.' });
        }
        const moment = await MomentPost.findOne({
          _id: momentPostId,
          author: friend._id,
          $or: [
            { shareMode: { $ne: 'selected' } },
            { recipientIds: user._id },
          ],
        })
          .select('media caption widget');
        if (!moment) {
          return response.status(404).json({ code: 'MOMENT_REPLY_NOT_FOUND', message: 'Khoảnh khắc này không còn khả dụng để trả lời.' });
        }
        momentReply = {
          postId: moment._id,
          media: {
            type: moment.media.type,
            path: moment.media.path,
            mimeType: moment.media.mimeType,
            filename: moment.media.filename,
          },
          caption: moment.caption || '',
          widget: moment.widget ? {
            type: moment.widget.type || '',
            badge: moment.widget.badge || '',
            title: moment.widget.title || '',
            color: moment.widget.color || '',
          } : undefined,
        };
      }

      const deliveredAt = isUserOnline(friend._id) ? new Date() : null;
      const message = await Message.create({
        conversationKey: conversationKeyFor(user._id, friend._id),
        participants: [user._id, friend._id],
        sender: user._id,
        recipient: friend._id,
        type,
        text,
        attachment,
        momentReply,
        replyTo,
        deliveredAt,
      });
      await populateMessage(message);
      const payload = messagePayload(message, isUserOnline);
      emitMessageEvent(friend._id, 'message:new', { message: payload });
      emitMessageEvent(user._id, 'message:new', { message: payload });
      void sendChatPushNotification({ recipientId: friend._id, sender: user, message: payload });
      return response.status(201).json({ message: payload });
    } catch (error) {
      await removeLocalAttachment(savedAttachmentPath);
      console.error('Send message failed:', error);
      return response.status(500).json({ code: 'SEND_MESSAGE_FAILED', message: error.message || 'Không thể gửi tin nhắn lúc này.' });
    }
  });

  return router;
}
