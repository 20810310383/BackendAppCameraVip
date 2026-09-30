import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import ffmpegPath from 'ffmpeg-static';
import mongoose from 'mongoose';
import multer from 'multer';
import sharp from 'sharp';
import { MomentPost } from '../models/MomentPost.js';
import { SharedChain } from '../models/SharedChain.js';
import { Session } from '../models/Session.js';
import { User } from '../models/User.js';
import { hashSessionToken } from '../services/session-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const momentUploadDirectory = path.resolve(__dirname, '../../uploads/moments');
const momentImageDirectory = path.join(momentUploadDirectory, 'images');
const momentVideoDirectory = path.join(momentUploadDirectory, 'videos');
const momentThumbnailDirectory = path.join(momentUploadDirectory, 'thumbnails');
const momentAudioDirectory = path.join(momentUploadDirectory, 'audio');
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_VIDEO_BYTES = 40 * 1024 * 1024;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_DAILY_VIDEOS = 10;
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic', 'image/heif']);
const AUDIO_MIME_TYPES = new Set(['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/x-m4a', 'audio/flac', 'audio/ogg', 'audio/webm']);

const momentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_BYTES, files: 2 },
  fileFilter: (_request, file, callback) => {
    const isImage = IMAGE_MIME_TYPES.has(file.mimetype) || file.mimetype?.startsWith('image/');
    const isVideo = file.mimetype?.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(file.originalname);
    const isAudio = AUDIO_MIME_TYPES.has(file.mimetype)
      || file.mimetype?.startsWith('audio/')
      || /\.(mp3|m4a|aac|wav|flac|ogg|opus|webm)$/i.test(file.originalname);
    if (file.fieldname === 'media' && (isImage || isVideo)) return callback(null, true);
    if (file.fieldname === 'musicAudio' && isAudio) return callback(null, true);
    return callback(new Error('Tệp khoảnh khắc không hợp lệ.'));
  },
}).fields([{ name: 'media', maxCount: 1 }, { name: 'musicAudio', maxCount: 1 }]);

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
    imageEdit: plain.imageEdit || null,
    timezoneOffsetMinutes: Number.isFinite(plain.timezoneOffsetMinutes) ? plain.timezoneOffsetMinutes : 0,
    authorLocalTime: plain.authorLocalTime || '',
    authorLocalDate: plain.authorLocalDate || '',
    viewCount: Array.isArray(plain.views) ? plain.views.length : 0,
    createdAt: new Date(plain.createdAt).toISOString(),
  };
}

function momentAudienceQuery(user, requestedAuthorId = null) {
  const currentAudience = requestedAuthorId
    ? { author: requestedAuthorId }
    : { author: { $in: [user._id, ...(user.friends || [])] } };

  return {
    $and: [
      currentAudience,
      {
        $or: [
          { author: user._id },
          // Existing posts have no shareMode and remain visible to all friends.
          { shareMode: { $ne: 'selected' } },
          { recipientIds: user._id },
        ],
      },
    ],
  };
}

function canUserViewMoment(post, user) {
  const authorId = post.author?._id?.toString?.() || post.author?.toString?.();
  if (!authorId) return false;
  if (authorId === user._id.toString()) return true;
  const isFriend = (user.friends || []).some((friendId) => friendId.toString() === authorId);
  if (!isFriend || post.shareMode !== 'selected') return isFriend;
  return (post.recipientIds || []).some((recipientId) => recipientId.toString() === user._id.toString());
}

function selectedMomentRecipients(user, recipientIds) {
  if (recipientIds === undefined) {
    return { shareMode: 'all', recipientIds: [], eventRecipients: (user.friends || []).map((id) => id.toString()) };
  }
  if (!Array.isArray(recipientIds)) return null;
  const friendIds = new Set((user.friends || []).map((id) => id.toString()));
  const uniqueIds = [...new Set(recipientIds)];
  if (uniqueIds.some((id) => typeof id !== 'string' || !mongoose.isValidObjectId(id) || !friendIds.has(id))) return null;
  return { shareMode: 'selected', recipientIds: uniqueIds, eventRecipients: uniqueIds };
}

function parseJsonField(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function clamp(value, min, max, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function authorLocalClock(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : '';
}

function authorLocalDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

async function emitSharedChainPostEvent(authorId, event, payload, emitPostEvent) {
  try {
    const chains = await SharedChain.find({ 'members.user': authorId }).select('_id members');
    for (const chain of chains) {
      const memberIds = new Set((chain.members || []).map((member) => member.user?.toString()).filter(Boolean));
      for (const memberId of memberIds) emitPostEvent(memberId, event, { chainId: chain._id.toString(), ...payload });
    }
  } catch (error) {
    // A realtime refresh must never make an already-saved moment look failed.
    console.error('Emit shared chain post event failed:', error);
  }
}

function sanitizeImageEdit(value) {
  if (!value || typeof value !== 'object') return null;
  const filterIds = new Set([
    'original', 'seoulPink', 'vintage1998', 'cyberpunk', 'sunsetWarm', 'hollywoodTeal',
    'blackWhiteNoir', 'matchaFresh', 'dreamyGlow', 'caramelLatte', 'coolNordic', 'cherryBlossom',
  ]);
  const filterId = typeof value.filterId === 'string' && filterIds.has(value.filterId) ? value.filterId : 'original';
  const imageEdit = {
    filterId,
    filterIntensity: clamp(value.filterIntensity, 0, 100, 100),
    brightnessLevel: clamp(value.brightnessLevel, -50, 50),
    contrastLevel: clamp(value.contrastLevel, -50, 50),
    warmthLevel: clamp(value.warmthLevel, -50, 50),
    saturationLevel: clamp(value.saturationLevel, -50, 50),
    vignetteLevel: clamp(value.vignetteLevel, 0, 100),
    grainLevel: clamp(value.grainLevel, 0, 100),
    smoothLevel: clamp(value.smoothLevel, 0, 100),
    sparkleFXEnabled: Boolean(value.sparkleFXEnabled),
  };
  const isEdited = imageEdit.filterId !== 'original'
    || imageEdit.brightnessLevel !== 0 || imageEdit.contrastLevel !== 0 || imageEdit.warmthLevel !== 0
    || imageEdit.saturationLevel !== 0 || imageEdit.vignetteLevel !== 0 || imageEdit.grainLevel !== 0
    || imageEdit.smoothLevel !== 0 || imageEdit.sparkleFXEnabled;
  return isEdited ? imageEdit : null;
}

function uploadedFile(request, fieldName) {
  const files = request.files?.[fieldName];
  return Array.isArray(files) ? files[0] : null;
}

function sanitizeStickers(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap((sticker) => {
    if (!sticker || typeof sticker !== 'object') return [];
    const emoji = typeof sticker.emoji === 'string' ? sticker.emoji.trim().slice(0, 24) : '';
    // Only accept stable catalogue IDs. This deliberately rules out arbitrary
    // URLs so sticker metadata cannot become a way to persist remote content.
    const assetId = typeof sticker.assetId === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(sticker.assetId.trim())
      ? sticker.assetId.trim()
      : '';
    if (!emoji && !assetId) return [];
    const positionMode = sticker.positionMode === 'relative' ? 'relative' : 'absolute';
    return [{
      kind: assetId ? 'asset' : 'emoji',
      ...(emoji ? { emoji } : {}),
      ...(assetId ? { assetId } : {}),
      // Relative coordinates are fractions of the original composition canvas.
      // Keep a little headroom for intentionally cropped / oversized stickers.
      x: Number.isFinite(Number(sticker.x))
        ? (positionMode === 'relative' ? Math.max(-0.25, Math.min(1.25, Number(sticker.x))) : Number(sticker.x))
        : 0,
      y: Number.isFinite(Number(sticker.y))
        ? (positionMode === 'relative' ? Math.max(-0.25, Math.min(1.25, Number(sticker.y))) : Number(sticker.y))
        : 0,
      positionMode,
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
    previewUrl: typeof rawMusic.previewUrl === 'string' && /^https?:\/\//i.test(rawMusic.previewUrl.trim())
      ? rawMusic.previewUrl.trim().slice(0, 1_200)
      : '',
    coverColors: Array.isArray(rawMusic.coverColors)
      ? rawMusic.coverColors.filter((item) => typeof item === 'string').slice(0, 2).map((item) => item.trim().slice(0, 24))
      : [],
  } : null;
  return title || badge || subtitle || type || icon || color || bgTint || borderColor || fontStyleId || fontColor || glowEffectId || music?.title
    ? { title, badge, subtitle, type, icon, color, bgTint, borderColor, fontStyleId, fontColor, glowEffectId, music }
    : null;
}

function vietnamDayStart() {
  const vietnamOffset = 7 * 60 * 60 * 1000;
  const day = 24 * 60 * 60 * 1000;
  return new Date(Math.floor((Date.now() + vietnamOffset) / day) * day - vietnamOffset);
}

function runFfmpeg(args) {
  if (!ffmpegPath) return Promise.reject(new Error('FFmpeg chưa sẵn sàng.'));
  return new Promise((resolve, reject) => {
    const command = spawn(ffmpegPath, args, { windowsHide: true });
    let errorOutput = '';
    const timer = setTimeout(() => {
      command.kill('SIGKILL');
      reject(new Error('Nén video quá thời gian cho phép.'));
    }, 120_000);
    command.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString();
    });
    command.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    command.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(errorOutput.slice(-600) || `FFmpeg kết thúc với mã ${code}.`));
    });
  });
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
    // Keep one optimized file only: 3200px/quality 94 remains materially
    // smaller than the original, while preserving enough detail for a user
    // to save and view the photo fullscreen on a modern phone.
    await image
      .resize({ width: 3200, height: 3200, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 94, effort: 5 })
      .toFile(destination);
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
  const randomId = randomBytes(12).toString('hex');
  const sourceFilename = `moment-source-${userId}-${randomId}${extension}`;
  const sourcePath = path.join(momentVideoDirectory, sourceFilename);
  const compressedFilename = `moment-${userId}-${randomId}.mp4`;
  const compressedPath = path.join(momentVideoDirectory, compressedFilename);
  const silentFilename = `moment-silent-${userId}-${randomId}.mp4`;
  const silentPath = path.join(momentVideoDirectory, silentFilename);
  await writeFile(sourcePath, file.buffer);

  let filename = sourceFilename;
  let mimeType = file.mimetype || 'video/mp4';
  try {
    await runFfmpeg([
      '-y',
      '-i', sourcePath,
      '-map', '0:v:0',
      // Chỉ thu nhỏ video quá lớn, tuyệt đối không phóng to nguồn 720p/1080p gây mờ hình.
      '-vf', 'scale=min(1280\\,iw):min(1280\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '22',
      '-pix_fmt', 'yuv420p',
      '-an',
      '-movflags', '+faststart',
      compressedPath,
    ]);
    const compressed = await stat(compressedPath);
    if (compressed.size > 0) {
      await unlink(sourcePath).catch(() => undefined);
      filename = compressedFilename;
      mimeType = 'video/mp4';
    } else {
      await unlink(compressedPath).catch(() => undefined);
    }
  } catch (error) {
    await unlink(compressedPath).catch(() => undefined);
    try {
      // Giữ đúng chính sách video không tiếng ngay cả khi lần nén đầu tiên thất bại.
      await runFfmpeg([
        '-y',
        '-i', sourcePath,
        '-map', '0:v:0',
        '-c:v', 'copy',
        '-an',
        '-movflags', '+faststart',
        silentPath,
      ]);
      const silent = await stat(silentPath);
      if (silent.size > 0) {
        await unlink(sourcePath).catch(() => undefined);
        filename = silentFilename;
        mimeType = 'video/mp4';
      }
    } catch (silentError) {
      await unlink(silentPath).catch(() => undefined);
      await unlink(sourcePath).catch(() => undefined);
      throw new Error(`Không thể xử lý video không tiếng: ${silentError.message || error.message}`);
    }
  }
  let thumbnailPath = '';
  try {
    await mkdir(momentThumbnailDirectory, { recursive: true });
    const thumbnailFilename = `moment-thumb-${userId}-${randomId}.jpg`;
    const thumbnailFilePath = path.join(momentThumbnailDirectory, thumbnailFilename);
    await runFfmpeg([
      '-y',
      '-ss', '0',
      '-i', path.join(momentVideoDirectory, filename),
      '-frames:v', '1',
      '-vf', 'scale=min(640\\,iw):min(640\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2',
      '-q:v', '3',
      thumbnailFilePath,
    ]);
    if ((await stat(thumbnailFilePath)).size > 0) {
      thumbnailPath = `/uploads/moments/thumbnails/${thumbnailFilename}`;
    }
  } catch (error) {
    console.warn(`Moment video thumbnail skipped: ${error.message}`);
  }

  return {
    type: 'video',
    path: `/uploads/moments/videos/${filename}`,
    mimeType,
    filename,
    thumbnailPath,
    durationMs: Number.isFinite(Number(durationMs)) ? Math.max(0, Math.round(Number(durationMs))) : undefined,
  };
}

async function persistMomentAudio(file, userId) {
  if (!file) return '';
  if (file.size > MAX_AUDIO_BYTES) throw new Error('Tệp nhạc tối đa 20 MB.');
  const extensionByMime = {
    'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/wav': '.wav',
    'audio/x-m4a': '.m4a', 'audio/flac': '.flac', 'audio/ogg': '.ogg', 'audio/webm': '.webm',
  };
  const sourceExtension = path.extname(file.originalname || '').toLowerCase();
  const extension = /^[.]([a-z0-9]{2,5})$/i.test(sourceExtension)
    ? sourceExtension
    : extensionByMime[file.mimetype] || '.m4a';
  const randomId = randomBytes(12).toString('hex');
  const sourceFilename = `moment-audio-source-${userId}-${randomId}${extension}`;
  const sourcePath = path.join(momentAudioDirectory, sourceFilename);
  const compressedFilename = `moment-audio-${userId}-${randomId}.m4a`;
  const compressedPath = path.join(momentAudioDirectory, compressedFilename);
  await mkdir(momentAudioDirectory, { recursive: true });
  await writeFile(sourcePath, file.buffer);

  try {
    // AAC 96 kbps is compact enough for moment background music while keeping
    // voices and most musical detail clear on phone speakers/headphones.
    await runFfmpeg([
      '-y', '-i', sourcePath, '-vn', '-c:a', 'aac', '-b:a', '96k',
      '-ac', '2', '-ar', '44100', '-movflags', '+faststart', compressedPath,
    ]);
    if ((await stat(compressedPath)).size > 0) {
      await unlink(sourcePath).catch(() => undefined);
      return `/uploads/moments/audio/${compressedFilename}`;
    }
  } catch (error) {
    console.warn(`Moment audio compression skipped: ${error.message}`);
  }

  await unlink(compressedPath).catch(() => undefined);
  return `/uploads/moments/audio/${sourceFilename}`;
}

async function removeLocalMoment(mediaOrPath) {
  const paths = typeof mediaOrPath === 'string'
    ? [mediaOrPath]
    : [mediaOrPath?.path, mediaOrPath?.thumbnailPath];
  await Promise.all(paths.map(async (pathname) => {
    if (!pathname?.startsWith('/uploads/moments/')) return;
    const folder = pathname.includes('/thumbnails/')
      ? momentThumbnailDirectory
      : pathname.includes('/videos/') ? momentVideoDirectory : momentImageDirectory;
    await unlink(path.join(folder, path.basename(pathname))).catch(() => undefined);
  }));
}

async function removeLocalMomentAudio(audioPath) {
  if (!audioPath?.startsWith('/uploads/moments/audio/')) return;
  await unlink(path.join(momentAudioDirectory, path.basename(audioPath))).catch(() => undefined);
}

async function ensureVideoThumbnail(post) {
  const media = post?.media;
  if (media?.type !== 'video') return '';
  if (media.thumbnailPath) return media.thumbnailPath;
  const videoFilename = path.basename(media.path || '');
  if (!videoFilename) return '';
  const thumbnailFilename = `moment-thumb-${path.basename(videoFilename, path.extname(videoFilename))}.jpg`;
  const thumbnailFilePath = path.join(momentThumbnailDirectory, thumbnailFilename);
  try {
    await mkdir(momentThumbnailDirectory, { recursive: true });
    const exists = await stat(thumbnailFilePath).then((file) => file.size > 0).catch(() => false);
    if (!exists) {
      await runFfmpeg([
        '-y', '-ss', '0', '-i', path.join(momentVideoDirectory, videoFilename), '-frames:v', '1',
        '-vf', 'scale=min(640\\,iw):min(640\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2',
        '-q:v', '3', thumbnailFilePath,
      ]);
    }
    if ((await stat(thumbnailFilePath)).size <= 0) return '';
    const thumbnailPath = `/uploads/moments/thumbnails/${thumbnailFilename}`;
    post.media.thumbnailPath = thumbnailPath;
    await MomentPost.updateOne({ _id: post._id }, { $set: { 'media.thumbnailPath': thumbnailPath } });
    return thumbnailPath;
  } catch (error) {
    console.warn(`Moment video thumbnail unavailable: ${error.message}`);
    return '';
  }
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
      message: tooLarge ? 'Video tối đa 40 MB, ảnh tối đa 12 MB và nhạc tối đa 20 MB.' : error.message || 'Tệp khoảnh khắc không hợp lệ.',
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
      const requestedAuthorId = String(request.query.authorId || '');
      if (requestedAuthorId && !mongoose.isValidObjectId(requestedAuthorId)) {
        return response.status(422).json({ code: 'INVALID_MOMENT_AUTHOR', message: 'Bộ lọc người đăng không hợp lệ.' });
      }
      if (requestedAuthorId && !audience.some((authorId) => authorId.toString() === requestedAuthorId)) {
        return response.status(403).json({ code: 'MOMENT_ACCESS_DENIED', message: 'Bạn chỉ có thể lọc khoảnh khắc của mình hoặc bạn bè.' });
      }
      const query = momentAudienceQuery(
        user,
        requestedAuthorId ? new mongoose.Types.ObjectId(requestedAuthorId) : null,
      );
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

  router.get('/moments/history', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const before = new Date(String(request.query.before || ''));
      const limit = Math.max(2, Math.min(Number(request.query.limit) || 12, 40));
      const audience = [user._id, ...(user.friends || [])];
      const requestedAuthorId = String(request.query.authorId || '');
      const requestedMediaType = String(request.query.mediaType || '');
      if (requestedAuthorId && !mongoose.isValidObjectId(requestedAuthorId)) {
        return response.status(422).json({ code: 'INVALID_MOMENT_AUTHOR', message: 'Bộ lọc người đăng không hợp lệ.' });
      }
      if (requestedMediaType && !['image', 'video'].includes(requestedMediaType)) {
        return response.status(422).json({ code: 'INVALID_MOMENT_MEDIA_TYPE', message: 'Loại khoảnh khắc không hợp lệ.' });
      }
      if (requestedAuthorId && !audience.some((authorId) => authorId.toString() === requestedAuthorId)) {
        return response.status(403).json({ code: 'MOMENT_ACCESS_DENIED', message: 'Bạn chỉ có thể xem thư viện của mình hoặc bạn bè.' });
      }
      const query = momentAudienceQuery(
        user,
        requestedAuthorId ? new mongoose.Types.ObjectId(requestedAuthorId) : null,
      );
      if (Number.isFinite(before.getTime())) query.createdAt = { $lt: before };
      if (requestedMediaType) query['media.type'] = requestedMediaType;
      const rows = await MomentPost.find(query)
        .sort({ createdAt: -1 })
        .limit(limit + 1)
        .populate({ path: 'author', select: 'fullName username avatarPath lastActiveAt' });
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      await Promise.all(rows.map((post) => ensureVideoThumbnail(post)));
      return response.json({ posts: rows.map((post) => postPayload(post, isUserOnline)), hasMore });
    } catch (error) {
      console.error('Get moment history failed:', error);
      return response.status(500).json({ code: 'GET_MOMENT_HISTORY_FAILED', message: 'Không thể tải thư viện khoảnh khắc lúc này.' });
    }
  });

  router.get('/moments/daily-stats', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const createdAt = { $gte: vietnamDayStart() };
      const [imageCount, videoCount] = await Promise.all([
        MomentPost.countDocuments({ author: user._id, 'media.type': 'image', createdAt }),
        MomentPost.countDocuments({ author: user._id, 'media.type': 'video', createdAt }),
      ]);
      return response.json({
        imageCount,
        videoCount,
        videoLimit: MAX_DAILY_VIDEOS,
      });
    } catch (error) {
      console.error('Get daily moment stats failed:', error);
      return response.status(500).json({ code: 'GET_MOMENT_DAILY_STATS_FAILED', message: 'Không thể tải hoạt động hôm nay.' });
    }
  });

  router.get('/moments/:postId', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      if (!mongoose.isValidObjectId(request.params.postId)) {
        return response.status(404).json({ code: 'MOMENT_NOT_FOUND', message: 'Không tìm thấy khoảnh khắc.' });
      }
      const post = await MomentPost.findById(request.params.postId)
        .populate({ path: 'author', select: 'fullName username avatarPath lastActiveAt' });
      if (!post) return response.status(404).json({ code: 'MOMENT_NOT_FOUND', message: 'Không tìm thấy khoảnh khắc.' });
      if (!canUserViewMoment(post, user)) {
        return response.status(403).json({ code: 'MOMENT_ACCESS_DENIED', message: 'Bạn không có quyền xem khoảnh khắc này.' });
      }
      return response.json({ post: postPayload(post, isUserOnline) });
    } catch (error) {
      console.error('Get moment failed:', error);
      return response.status(500).json({ code: 'GET_MOMENT_FAILED', message: 'Không thể tải khoảnh khắc lúc này.' });
    }
  });

  router.post('/moments', runMomentUpload, async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    let savedMedia = null;
    let savedMusicAudioPath = '';
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const mediaFile = uploadedFile(request, 'media');
      const musicAudioFile = uploadedFile(request, 'musicAudio');
      if (!mediaFile) return response.status(422).json({ code: 'MOMENT_MEDIA_REQUIRED', message: 'Vui lòng chọn ảnh hoặc video để đăng.' });
      const rawRecipientIds = request.body?.recipientIds;
      const parsedRecipientIds = rawRecipientIds === undefined ? undefined : parseJsonField(rawRecipientIds, null);
      const audience = selectedMomentRecipients(user, parsedRecipientIds);
      if (!audience) {
        return response.status(422).json({
          code: 'INVALID_MOMENT_RECIPIENTS',
          message: 'Danh sách người được chia sẻ không hợp lệ. Hãy chọn lại bạn bè rồi thử lại.',
        });
      }
      const widget = sanitizeWidget(parseJsonField(request.body?.widget, null));
      if (musicAudioFile && widget?.type !== 'music') {
        return response.status(422).json({ code: 'MOMENT_AUDIO_WITHOUT_MUSIC', message: 'Tệp nhạc chỉ có thể được gắn với tiện ích Nhạc.' });
      }
      const isVideo = mediaFile.mimetype?.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(mediaFile.originalname);
      if (isVideo) {
        const todayVideoCount = await MomentPost.countDocuments({
          author: user._id,
          'media.type': 'video',
          createdAt: { $gte: vietnamDayStart() },
        });
        if (todayVideoCount >= MAX_DAILY_VIDEOS) {
          return response.status(429).json({
            code: 'MOMENT_VIDEO_DAILY_LIMIT',
            message: 'Mỗi tài khoản chỉ được đăng tối đa 10 video mỗi ngày.',
          });
        }
      }

      const media = await persistMedia(mediaFile, user._id.toString(), request.body?.durationMs);
      savedMedia = media;
      if (musicAudioFile) {
        savedMusicAudioPath = await persistMomentAudio(musicAudioFile, user._id.toString());
        widget.music = { ...(widget.music || {}), previewUrl: savedMusicAudioPath };
      }
      const post = await MomentPost.create({
        author: user._id,
        media,
        caption: typeof request.body?.caption === 'string' ? request.body.caption.trim().slice(0, 500) : '',
        stickers: sanitizeStickers(parseJsonField(request.body?.stickers, [])),
        widget,
        imageEdit: media.type === 'image' ? sanitizeImageEdit(parseJsonField(request.body?.imageEdit, null)) : null,
        timezoneOffsetMinutes: clamp(request.body?.timezoneOffsetMinutes, -840, 840),
        authorLocalTime: authorLocalClock(request.body?.authorLocalTime),
        authorLocalDate: authorLocalDay(request.body?.authorLocalDate),
        shareMode: audience.shareMode,
        recipientIds: audience.recipientIds,
      });
      await post.populate({ path: 'author', select: 'fullName username avatarPath lastActiveAt' });
      const payload = postPayload(post, isUserOnline);
      const recipients = new Set([user._id.toString(), ...audience.eventRecipients]);
      for (const recipientId of recipients) emitPostEvent(recipientId, 'moment:new', { post: payload });
      await emitSharedChainPostEvent(user._id, 'shared-chain:post-created', {}, emitPostEvent);
      return response.status(201).json({ post: payload });
    } catch (error) {
      if (savedMedia) await removeLocalMoment(savedMedia);
      if (savedMusicAudioPath) await removeLocalMomentAudio(savedMusicAudioPath);
      console.error('Create moment failed:', error);
      return response.status(500).json({ code: 'CREATE_MOMENT_FAILED', message: error.message || 'Không thể đăng khoảnh khắc lúc này.' });
    }
  });

  router.delete('/moments/:postId', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      if (!mongoose.isValidObjectId(request.params.postId)) {
        return response.status(404).json({ code: 'MOMENT_NOT_FOUND', message: 'Không tìm thấy khoảnh khắc.' });
      }
      const post = await MomentPost.findById(request.params.postId).select('author media widget shareMode recipientIds');
      if (!post) return response.status(404).json({ code: 'MOMENT_NOT_FOUND', message: 'Không tìm thấy khoảnh khắc.' });
      if (post.author.toString() !== user._id.toString()) {
        return response.status(403).json({ code: 'MOMENT_DELETE_FORBIDDEN', message: 'Bạn chỉ có thể xóa khoảnh khắc do chính mình đăng.' });
      }
      await MomentPost.deleteOne({ _id: post._id });
      await removeLocalMoment(post.media);
      await removeLocalMomentAudio(post.widget?.music?.previewUrl);
      const recipients = new Set([
        user._id.toString(),
        ...(post.shareMode === 'selected'
          ? (post.recipientIds || []).map((id) => id.toString())
          : (user.friends || []).map((id) => id.toString())),
      ]);
      for (const recipientId of recipients) emitPostEvent(recipientId, 'moment:deleted', { postId: post._id.toString() });
      await emitSharedChainPostEvent(user._id, 'shared-chain:post-deleted', {}, emitPostEvent);
      return response.json({ ok: true, postId: post._id.toString() });
    } catch (error) {
      console.error('Delete moment failed:', error);
      return response.status(500).json({ code: 'DELETE_MOMENT_FAILED', message: 'Không thể xóa khoảnh khắc lúc này.' });
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
      const post = await MomentPost.findById(request.params.postId).select('author shareMode recipientIds views');
      if (!post) return response.status(404).json({ code: 'MOMENT_NOT_FOUND', message: 'Không tìm thấy khoảnh khắc.' });

      if (!canUserViewMoment(post, user)) {
        return response.status(403).json({ code: 'MOMENT_ACCESS_DENIED', message: 'Bạn không có quyền xem khoảnh khắc này.' });
      }
      const viewedAt = new Date();
      let recordedNewView = false;
      const isAuthor = post.author.toString() === user._id.toString();
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
