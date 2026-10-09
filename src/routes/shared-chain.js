import { randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { MomentPost } from '../models/MomentPost.js';
import { FriendRequest } from '../models/FriendRequest.js';
import { Session } from '../models/Session.js';
import { SharedChain } from '../models/SharedChain.js';
import { User } from '../models/User.js';
import { deleteStoredObject, storeProcessedFile } from '../services/object-storage-service.js';
import {
  sendFriendRequestPushNotification,
  sendSharedChainInvitationPushNotification,
  sendSharedChainInvitationReviewPushNotification,
  sendSharedChainJoinRequestPushNotification,
} from '../services/push-service.js';
import { hashSessionToken } from '../services/session-service.js';

const MAX_GROUPS_PER_OWNER = 12;
const MAX_GROUP_MEMBERS = 20;
const MAX_UPLOAD_SIZE_BYTES = 12 * 1024 * 1024;
const INVITE_CODE_LENGTH = 8;
const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic', 'image/heif']);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const groupAvatarDirectory = path.resolve(__dirname, '../../uploads/shared-chains');

const groupAvatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_SIZE_BYTES, files: 1 },
  fileFilter: (_request, file, callback) => {
    if (IMAGE_MIME_TYPES.has(file.mimetype)) callback(null, true);
    else callback(new Error('Chỉ hỗ trợ ảnh JPG, PNG, WebP, AVIF hoặc HEIC.'));
  },
}).single('avatar');

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

function idOf(value) {
  return value?._id?.toString?.() || value?.id?.toString?.() || value?.toString?.() || '';
}

function friendPairKey(firstUserId, secondUserId) {
  return [firstUserId.toString(), secondUserId.toString()].sort().join(':');
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

function normalizeTitle(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function normalizeInviteCode(value) {
  return typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

function isCurrentMember(chain, userId) {
  const userIdString = idOf(userId);
  return (chain.members || []).some((member) => idOf(member.user) === userIdString);
}

function reservedSeatCount(chain) {
  return (chain.members || []).length
    + (chain.pendingInvitations || []).length
    + (chain.pendingJoinRequests || []).length;
}

function hasAvailableSeat(chain, requestedCount = 1) {
  return reservedSeatCount(chain) + requestedCount <= MAX_GROUP_MEMBERS;
}

function assertValidChainId(response, chainId) {
  if (mongoose.isValidObjectId(chainId)) return true;
  response.status(404).json({ code: 'SHARED_CHAIN_NOT_FOUND', message: 'Không tìm thấy nhóm.' });
  return false;
}

async function populateChain(chain) {
  return chain.populate([
    { path: 'owner', select: 'fullName username avatarPath lastActiveAt' },
    { path: 'members.user', select: 'fullName username avatarPath lastActiveAt' },
    { path: 'pendingInvitations.user', select: 'fullName username avatarPath lastActiveAt' },
    { path: 'pendingInvitations.invitedBy', select: 'fullName username avatarPath lastActiveAt' },
    { path: 'pendingJoinRequests.user', select: 'fullName username avatarPath lastActiveAt' },
  ]);
}

function chainPayload(chain, viewer, isUserOnline) {
  const ownerId = idOf(chain.owner);
  const viewerId = viewer._id.toString();
  const isMember = isCurrentMember(chain, viewer._id);
  const canManage = ownerId === viewerId;
  const members = (chain.members || [])
    .filter((member) => member.user)
    .map((member) => ({
      user: userPayload(member.user, isUserOnline),
      joinedAt: new Date(member.joinedAt).toISOString(),
    }));
  const pendingInvitations = isMember
    ? (chain.pendingInvitations || []).filter((invitation) => invitation.user).map((invitation) => ({
      user: userPayload(invitation.user, isUserOnline),
      invitedBy: invitation.invitedBy ? userPayload(invitation.invitedBy, isUserOnline) : null,
      createdAt: new Date(invitation.createdAt).toISOString(),
      awaitingOwnerApproval: Boolean(invitation.awaitingOwnerApproval),
      isFriendOfOwner: invitation.isFriendOfOwner !== false,
      awaitingFriendship: Boolean(invitation.awaitingFriendship),
    }))
    : [];
  const pendingJoinRequests = canManage
    ? (chain.pendingJoinRequests || []).filter((entry) => entry.user).map((entry) => ({
      user: userPayload(entry.user, isUserOnline),
      requestedAt: new Date(entry.requestedAt).toISOString(),
    }))
    : [];
  return {
    id: chain._id.toString(),
    title: chain.title || 'Chuỗi chung',
    avatarPath: chain.avatarPath || '',
    ownerId,
    inviteCode: canManage ? chain.inviteCode || '' : '',
    memberLimit: MAX_GROUP_MEMBERS,
    members,
    pendingInvitations,
    pendingJoinRequests,
    canInvite: isMember && hasAvailableSeat(chain),
    canManage,
    createdAt: new Date(chain.createdAt).toISOString(),
    updatedAt: new Date(chain.updatedAt).toISOString(),
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

async function createInviteCode() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    let code = '';
    const bytes = randomBytes(INVITE_CODE_LENGTH);
    for (const byte of bytes) code += INVITE_CODE_ALPHABET[byte % INVITE_CODE_ALPHABET.length];
    // The unique index is the final race-condition safeguard.
    // This lookup lets the normal path avoid a duplicate-key retry.
    // eslint-disable-next-line no-await-in-loop
    if (!await SharedChain.exists({ inviteCode: code })) return code;
  }
  throw new Error('Could not allocate a unique shared chain invite code.');
}

async function ensureInviteCode(chain) {
  if (chain.inviteCode) return chain;
  chain.inviteCode = await createInviteCode();
  await chain.save();
  return chain;
}

async function optimizeGroupAvatar(file, ownerId) {
  await mkdir(groupAvatarDirectory, { recursive: true });
  const filename = `group-${ownerId}-${randomBytes(12).toString('hex')}.webp`;
  const destination = path.join(groupAvatarDirectory, filename);
  const optimized = await sharp(file.buffer, { failOn: 'none', limitInputPixels: 24_000_000 })
    .rotate()
    .resize({ width: 1024, height: 1024, fit: 'cover', position: 'attention', withoutEnlargement: true })
    .webp({ quality: 88, effort: 5, smartSubsample: true })
    .toBuffer();
  await writeFile(destination, optimized);
  return storeProcessedFile({
    localPath: destination,
    localUrl: `/uploads/shared-chains/${filename}`,
    objectKey: `media/shared-chains/${filename}`,
    contentType: 'image/webp',
  });
}

async function removeLocalGroupAvatar(avatarPath) {
  if (await deleteStoredObject(avatarPath)) return;
  if (!avatarPath?.startsWith('/uploads/shared-chains/')) return;
  await unlink(path.join(groupAvatarDirectory, path.basename(avatarPath))).catch(() => undefined);
}

function runGroupAvatarUpload(request, response, next) {
  groupAvatarUpload(request, response, (error) => {
    if (!error) return next();
    const tooLarge = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
    return response.status(tooLarge ? 413 : 422).json({
      code: tooLarge ? 'IMAGE_TOO_LARGE' : 'INVALID_IMAGE',
      message: tooLarge ? 'Ảnh đại diện nhóm tối đa 12 MB.' : error.message || 'Ảnh tải lên không hợp lệ.',
    });
  });
}

async function findMemberChain(chainId, user, response) {
  if (!assertValidChainId(response, chainId)) return null;
  const chain = await SharedChain.findById(chainId);
  if (!chain) {
    response.status(404).json({ code: 'SHARED_CHAIN_NOT_FOUND', message: 'Nhóm không còn tồn tại.' });
    return null;
  }
  if (!isCurrentMember(chain, user._id)) {
    response.status(403).json({ code: 'SHARED_CHAIN_ACCESS_FORBIDDEN', message: 'Bạn chưa là thành viên của nhóm này.' });
    return null;
  }
  return chain;
}

export function createSharedChainRouter({ isDatabaseReady, isUserOnline = () => false, emitSharedChainEvent = () => undefined }) {
  const router = Router();

  const emitToMembers = (chain, event, payload = {}) => {
    const recipients = new Set([
      ...(chain.members || []).map((member) => idOf(member.user)),
      ...(chain.pendingInvitations || []).map((invitation) => idOf(invitation.user)),
      ...(chain.pendingJoinRequests || []).map((entry) => idOf(entry.user)),
    ].filter(Boolean));
    for (const userId of recipients) emitSharedChainEvent(userId, event, { chainId: chain._id.toString(), ...payload });
  };

  router.get('/shared-chains', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const [chains, createdCount] = await Promise.all([
        SharedChain.find({ 'members.user': user._id }).sort({ updatedAt: -1 }),
        SharedChain.countDocuments({ owner: user._id }),
      ]);
      await Promise.all(chains.map(async (chain) => {
        await ensureInviteCode(chain);
        await populateChain(chain);
      }));
      return response.json({
        chains: chains.map((chain) => chainPayload(chain, user, isUserOnline)),
        createdCount,
        createLimit: MAX_GROUPS_PER_OWNER,
      });
    } catch (error) {
      console.error('List shared chains failed:', error);
      return response.status(500).json({ code: 'LIST_SHARED_CHAINS_FAILED', message: 'Không thể tải các nhóm lúc này.' });
    }
  });

  router.post('/shared-chains', runGroupAvatarUpload, async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    let newAvatarPath = '';
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const title = normalizeTitle(request.body?.title);
      if (title.length < 2 || title.length > 80) {
        return response.status(422).json({ code: 'SHARED_CHAIN_TITLE_INVALID', message: 'Tên nhóm cần từ 2 đến 80 ký tự.' });
      }
      const createdCount = await SharedChain.countDocuments({ owner: user._id });
      if (createdCount >= MAX_GROUPS_PER_OWNER) {
        return response.status(409).json({ code: 'SHARED_CHAIN_CREATE_LIMIT', message: `Mỗi tài khoản chỉ có thể tạo tối đa ${MAX_GROUPS_PER_OWNER} nhóm.` });
      }
      if (request.file) newAvatarPath = await optimizeGroupAvatar(request.file, user._id.toString());
      const chain = new SharedChain({
        title,
        avatarPath: newAvatarPath,
        owner: user._id,
        inviteCode: await createInviteCode(),
        members: [{ user: user._id, joinedAt: new Date() }],
      });
      await chain.save();
      await populateChain(chain);
      return response.status(201).json({ chain: chainPayload(chain, user, isUserOnline) });
    } catch (error) {
      if (newAvatarPath) await removeLocalGroupAvatar(newAvatarPath);
      console.error('Create shared chain failed:', error);
      return response.status(500).json({ code: 'CREATE_SHARED_CHAIN_FAILED', message: 'Không thể tạo nhóm lúc này.' });
    }
  });

  router.post('/shared-chains/join-requests', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const inviteCode = normalizeInviteCode(request.body?.code);
      if (inviteCode.length !== INVITE_CODE_LENGTH) {
        return response.status(422).json({ code: 'SHARED_CHAIN_CODE_INVALID', message: 'Mã nhóm không hợp lệ.' });
      }
      const chain = await SharedChain.findOne({ inviteCode });
      if (!chain) return response.status(404).json({ code: 'SHARED_CHAIN_CODE_NOT_FOUND', message: 'Không tìm thấy nhóm với mã này.' });
      if (isCurrentMember(chain, user._id)) {
        return response.status(409).json({ code: 'SHARED_CHAIN_ALREADY_MEMBER', message: 'Bạn đã là thành viên của nhóm này.' });
      }
      const userId = user._id.toString();
      const pendingInvitation = (chain.pendingInvitations || []).find((entry) => idOf(entry.user) === userId);
      if (pendingInvitation) {
        if (pendingInvitation.awaitingOwnerApproval) {
          return response.status(409).json({ code: 'SHARED_CHAIN_INVITATION_OWNER_REVIEW_PENDING', message: 'Một thành viên đã đề xuất mời bạn vào nhóm này và đang chờ chủ nhóm phê duyệt.' });
        }
        return response.status(409).json({ code: 'SHARED_CHAIN_DIRECT_INVITATION_PENDING', message: 'Bạn đã có lời mời vào nhóm này. Hãy xác nhận lời mời trong thông báo.' });
      }
      if ((chain.pendingJoinRequests || []).some((entry) => idOf(entry.user) === userId)) {
        return response.status(409).json({ code: 'SHARED_CHAIN_JOIN_REQUEST_PENDING', message: 'Bạn đã xin tham gia nhóm này và đang chờ chủ nhóm phê duyệt.' });
      }
      if (!hasAvailableSeat(chain)) {
        return response.status(409).json({ code: 'SHARED_CHAIN_MEMBER_LIMIT', message: `Nhóm này đã đủ ${MAX_GROUP_MEMBERS} thành viên hoặc yêu cầu chờ duyệt.` });
      }
      chain.pendingJoinRequests.push({ user: user._id, requestedAt: new Date() });
      await chain.save();
      emitSharedChainEvent(chain.owner, 'shared-chain:join-request', { chainId: chain._id.toString() });
      void sendSharedChainJoinRequestPushNotification({
        recipientId: chain.owner,
        sender: user,
        chainId: chain._id.toString(),
        chainTitle: chain.title,
      });
      return response.status(201).json({
        ok: true,
        message: 'Đã gửi yêu cầu tham gia. Chủ nhóm sẽ phê duyệt hoặc từ chối.',
        chainId: chain._id.toString(),
      });
    } catch (error) {
      console.error('Create shared chain join request failed:', error);
      return response.status(500).json({ code: 'CREATE_SHARED_CHAIN_JOIN_REQUEST_FAILED', message: 'Không thể gửi yêu cầu tham gia nhóm.' });
    }
  });

  router.get('/shared-chains/join-requests', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const chains = await SharedChain.find({ 'pendingJoinRequests.user': user._id }).sort({ updatedAt: -1 });
      await Promise.all(chains.map((chain) => populateChain(chain)));
      const outgoingJoinRequests = chains.flatMap((chain) => (chain.pendingJoinRequests || [])
        .filter((entry) => idOf(entry.user) === user._id.toString())
        .map((entry) => ({
          chainId: chain._id.toString(),
          title: chain.title || 'Chuỗi chung',
          avatarPath: chain.avatarPath || '',
          owner: userPayload(chain.owner, isUserOnline),
          requestedAt: new Date(entry.requestedAt).toISOString(),
        })));
      return response.json({ outgoingJoinRequests });
    } catch (error) {
      console.error('Get outgoing shared chain join requests failed:', error);
      return response.status(500).json({ code: 'GET_OUTGOING_SHARED_CHAIN_JOIN_REQUESTS_FAILED', message: 'Không thể tải các yêu cầu tham gia đang chờ.' });
    }
  });

  router.get('/shared-chains/invitations', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const chains = await SharedChain.find({ 'pendingInvitations.user': user._id }).sort({ updatedAt: -1 });
      await Promise.all(chains.map((chain) => populateChain(chain)));
      const invitations = chains.flatMap((chain) => (chain.pendingInvitations || [])
        .filter((invitation) => idOf(invitation.user) === user._id.toString() && !invitation.awaitingOwnerApproval && !invitation.awaitingFriendship)
        .map((invitation) => ({
          chainId: chain._id.toString(),
          title: chain.title || 'Chuỗi chung',
          invitedBy: invitation.invitedBy ? userPayload(invitation.invitedBy, isUserOnline) : userPayload(chain.owner, isUserOnline),
          createdAt: new Date(invitation.createdAt).toISOString(),
        })));
      return response.json({ invitations });
    } catch (error) {
      console.error('Get shared chain invitations failed:', error);
      return response.status(500).json({ code: 'GET_SHARED_CHAIN_INVITATIONS_FAILED', message: 'Không thể tải lời mời Chuỗi chung.' });
    }
  });

  router.post('/shared-chains/:chainId/invitations/respond', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      if (!assertValidChainId(response, request.params.chainId)) return;
      const action = request.body?.action;
      if (!['accept', 'decline'].includes(action)) {
        return response.status(422).json({ code: 'SHARED_CHAIN_INVITATION_ACTION_INVALID', message: 'Phản hồi lời mời không hợp lệ.' });
      }
      const chain = await SharedChain.findById(request.params.chainId);
      if (!chain) return response.status(404).json({ code: 'SHARED_CHAIN_NOT_FOUND', message: 'Nhóm không còn tồn tại.' });
      const invitationIndex = (chain.pendingInvitations || []).findIndex((entry) => idOf(entry.user) === user._id.toString());
      if (invitationIndex < 0) return response.status(404).json({ code: 'SHARED_CHAIN_INVITATION_NOT_FOUND', message: 'Lời mời này không còn hiệu lực.' });
      if (chain.pendingInvitations[invitationIndex].awaitingOwnerApproval) {
        return response.status(409).json({ code: 'SHARED_CHAIN_INVITATION_OWNER_REVIEW_PENDING', message: 'Lời mời này đang chờ chủ nhóm phê duyệt.' });
      }
      if (chain.pendingInvitations[invitationIndex].awaitingFriendship) {
        return response.status(409).json({ code: 'SHARED_CHAIN_INVITATION_FRIENDSHIP_PENDING', message: 'Hãy xác nhận lời mời kết bạn của chủ nhóm trước khi tham gia nhóm.' });
      }
      if (action === 'accept' && !isCurrentMember(chain, user._id) && (chain.members || []).length >= MAX_GROUP_MEMBERS) {
        return response.status(409).json({ code: 'SHARED_CHAIN_MEMBER_LIMIT', message: `Nhóm này đã đủ ${MAX_GROUP_MEMBERS} thành viên.` });
      }
      chain.pendingInvitations.splice(invitationIndex, 1);
      if (action === 'accept' && !isCurrentMember(chain, user._id)) {
        chain.members.push({ user: user._id, joinedAt: new Date() });
      }
      await chain.save();
      await populateChain(chain);
      emitToMembers(chain, 'shared-chain:updated');
      return response.json({ ok: true, action, chain: action === 'accept' ? chainPayload(chain, user, isUserOnline) : null });
    } catch (error) {
      console.error('Respond shared chain invitation failed:', error);
      return response.status(500).json({ code: 'RESPOND_SHARED_CHAIN_INVITATION_FAILED', message: 'Không thể xử lý lời mời Chuỗi chung.' });
    }
  });

  router.get('/shared-chains/:chainId', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const chain = await findMemberChain(request.params.chainId, user, response);
      if (!chain) return;
      await ensureInviteCode(chain);
      await populateChain(chain);
      return response.json({ chain: chainPayload(chain, user, isUserOnline) });
    } catch (error) {
      console.error('Get shared chain failed:', error);
      return response.status(500).json({ code: 'GET_SHARED_CHAIN_FAILED', message: 'Không thể tải nhóm lúc này.' });
    }
  });

  router.patch('/shared-chains/:chainId', runGroupAvatarUpload, async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    let newAvatarPath = '';
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      if (!assertValidChainId(response, request.params.chainId)) return;
      const chain = await SharedChain.findById(request.params.chainId);
      if (!chain) return response.status(404).json({ code: 'SHARED_CHAIN_NOT_FOUND', message: 'Nhóm không còn tồn tại.' });
      if (idOf(chain.owner) !== user._id.toString()) {
        return response.status(403).json({ code: 'SHARED_CHAIN_MANAGE_FORBIDDEN', message: 'Chỉ chủ nhóm mới có thể chỉnh sửa nhóm.' });
      }
      const hasTitle = Object.prototype.hasOwnProperty.call(request.body || {}, 'title');
      if (hasTitle) {
        const title = normalizeTitle(request.body.title);
        if (title.length < 2 || title.length > 80) {
          return response.status(422).json({ code: 'SHARED_CHAIN_TITLE_INVALID', message: 'Tên nhóm cần từ 2 đến 80 ký tự.' });
        }
        chain.title = title;
      }
      if (request.file) {
        newAvatarPath = await optimizeGroupAvatar(request.file, user._id.toString());
        const oldAvatarPath = chain.avatarPath;
        chain.avatarPath = newAvatarPath;
        await chain.save();
        await removeLocalGroupAvatar(oldAvatarPath);
      } else {
        if (!hasTitle) return response.status(422).json({ code: 'SHARED_CHAIN_UPDATE_EMPTY', message: 'Chưa có thông tin nào để cập nhật.' });
        await chain.save();
      }
      await ensureInviteCode(chain);
      await populateChain(chain);
      emitToMembers(chain, 'shared-chain:updated');
      return response.json({ chain: chainPayload(chain, user, isUserOnline) });
    } catch (error) {
      if (newAvatarPath) await removeLocalGroupAvatar(newAvatarPath);
      console.error('Update shared chain failed:', error);
      return response.status(500).json({ code: 'UPDATE_SHARED_CHAIN_FAILED', message: 'Không thể cập nhật nhóm lúc này.' });
    }
  });

  router.get('/shared-chains/:chainId/posts', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const chain = await findMemberChain(request.params.chainId, user, response);
      if (!chain) return;
      const before = new Date(String(request.query.before || ''));
      const limit = Math.max(3, Math.min(Number(request.query.limit) || 12, 40));
      const mediaType = String(request.query.type || 'all');
      if (!['all', 'image', 'video'].includes(mediaType)) {
        return response.status(422).json({ code: 'INVALID_SHARED_CHAIN_FILTER', message: 'Bộ lọc khoảnh khắc không hợp lệ.' });
      }
      const memberIds = (chain.members || []).map((member) => member.user);
      const requestedAuthorId = String(request.query.authorId || '');
      if (requestedAuthorId && !mongoose.isValidObjectId(requestedAuthorId)) {
        return response.status(422).json({ code: 'INVALID_SHARED_CHAIN_AUTHOR', message: 'Bộ lọc người đăng không hợp lệ.' });
      }
      if (requestedAuthorId && !memberIds.some((memberId) => idOf(memberId) === requestedAuthorId)) {
        return response.status(403).json({ code: 'SHARED_CHAIN_AUTHOR_FORBIDDEN', message: 'Bạn chỉ có thể lọc khoảnh khắc của thành viên trong nhóm.' });
      }
      const query = {
        author: requestedAuthorId ? new mongoose.Types.ObjectId(requestedAuthorId) : { $in: memberIds },
        $or: [
          { sharedChainIds: chain._id },
          // Posts from before manual selection existed keep their previous
          // automatic visibility until somebody explicitly removes them.
          { sharedChainSelectionStarted: { $ne: true }, sharedChainExcludedIds: { $ne: chain._id } },
        ],
      };
      if (mediaType !== 'all') query['media.type'] = mediaType;
      if (Number.isFinite(before.getTime())) query.createdAt = { $lt: before };
      const rows = await MomentPost.find(query)
        .sort({ createdAt: -1 })
        .limit(limit + 1)
        .populate({ path: 'author', select: 'fullName username avatarPath lastActiveAt' });
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      return response.json({ posts: rows.map((post) => postPayload(post, isUserOnline)), hasMore });
    } catch (error) {
      console.error('Get shared chain posts failed:', error);
      return response.status(500).json({ code: 'GET_SHARED_CHAIN_POSTS_FAILED', message: 'Không thể tải khoảnh khắc của nhóm.' });
    }
  });

  router.get('/shared-chains/:chainId/post-candidates', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const chain = await findMemberChain(request.params.chainId, user, response);
      if (!chain) return;
      const memberIds = (chain.members || []).map((member) => member.user);
      const canManage = idOf(chain.owner) === user._id.toString();
      const author = canManage ? { $in: memberIds } : user._id;
      const rows = await MomentPost.find({ author })
        .sort({ createdAt: -1 })
        .limit(100)
        .populate({ path: 'author', select: 'fullName username avatarPath lastActiveAt' })
        .lean();
      return response.json({
        posts: rows.map((post) => {
          const isExplicitlyIncluded = (post.sharedChainIds || []).some((chainId) => idOf(chainId) === chain._id.toString());
          const isLegacyIncluded = post.sharedChainSelectionStarted !== true
            && !(post.sharedChainExcludedIds || []).some((chainId) => idOf(chainId) === chain._id.toString());
          return { ...postPayload(post, isUserOnline), included: isExplicitlyIncluded || isLegacyIncluded };
        }),
      });
    } catch (error) {
      console.error('Get shared chain post candidates failed:', error);
      return response.status(500).json({ code: 'GET_SHARED_CHAIN_POST_CANDIDATES_FAILED', message: 'Không thể tải bài đăng để chọn.' });
    }
  });

  router.put('/shared-chains/:chainId/posts/:postId', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      if (!assertValidChainId(response, request.params.chainId) || !mongoose.isValidObjectId(request.params.postId)) {
        if (mongoose.isValidObjectId(request.params.chainId)) response.status(404).json({ code: 'MOMENT_NOT_FOUND', message: 'Không tìm thấy bài đăng.' });
        return;
      }
      if (typeof request.body?.included !== 'boolean') {
        return response.status(422).json({ code: 'SHARED_CHAIN_POST_SELECTION_INVALID', message: 'Trạng thái chọn bài đăng không hợp lệ.' });
      }
      const chain = await findMemberChain(request.params.chainId, user, response);
      if (!chain) return;
      const post = await MomentPost.findById(request.params.postId).select('author sharedChainIds sharedChainExcludedIds');
      if (!post) return response.status(404).json({ code: 'MOMENT_NOT_FOUND', message: 'Không tìm thấy bài đăng.' });
      if (!isCurrentMember(chain, post.author)) {
        return response.status(403).json({ code: 'SHARED_CHAIN_POST_AUTHOR_FORBIDDEN', message: 'Chỉ có thể chọn bài đăng của thành viên hiện tại trong nhóm.' });
      }
      const canManage = idOf(chain.owner) === user._id.toString();
      if (!canManage && idOf(post.author) !== user._id.toString()) {
        return response.status(403).json({ code: 'SHARED_CHAIN_POST_MANAGE_FORBIDDEN', message: 'Bạn chỉ có thể thêm hoặc bỏ bài đăng của chính mình.' });
      }
      const update = request.body.included
        ? { $addToSet: { sharedChainIds: chain._id }, $pull: { sharedChainExcludedIds: chain._id } }
        : { $pull: { sharedChainIds: chain._id }, $addToSet: { sharedChainExcludedIds: chain._id } };
      await MomentPost.updateOne({ _id: post._id }, update);
      response.json({ ok: true, postId: post._id.toString(), included: request.body.included });
      // Send realtime refreshes only after the caller has been given the result
      // of its own action, avoiding a local socket refresh racing the HTTP reply.
      try {
        emitToMembers(chain, 'shared-chain:posts-updated', { postId: post._id.toString(), included: request.body.included });
      } catch (error) {
        // The selection has already been saved and acknowledged. A socket
        // failure must not turn that completed HTTP request into an error.
        console.error('Emit shared chain post selection event failed:', error);
      }
      return;
    } catch (error) {
      console.error('Update shared chain post selection failed:', error);
      return response.status(500).json({ code: 'UPDATE_SHARED_CHAIN_POST_SELECTION_FAILED', message: 'Không thể cập nhật bài đăng trong nhóm.' });
    }
  });

  router.post('/shared-chains/:chainId/invitations', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const chain = await findMemberChain(request.params.chainId, user, response);
      if (!chain) return;
      const requestedIds = Array.isArray(request.body?.friendIds) ? request.body.friendIds : [];
      const friendIds = [...new Set(requestedIds.filter((id) => typeof id === 'string' && mongoose.isValidObjectId(id)))];
      if (!friendIds.length) return response.status(422).json({ code: 'SHARED_CHAIN_INVITEE_REQUIRED', message: 'Hãy chọn ít nhất một người bạn để mời.' });
      const validFriends = new Set((user.friends || []).map((friendId) => friendId.toString()));
      if (friendIds.some((id) => !validFriends.has(id))) {
        return response.status(422).json({ code: 'SHARED_CHAIN_INVITEE_INVALID', message: 'Bạn chỉ có thể mời bạn bè hiện tại vào nhóm.' });
      }
      const unavailableIds = new Set([
        ...(chain.members || []).map((entry) => idOf(entry.user)),
        ...(chain.pendingInvitations || []).map((entry) => idOf(entry.user)),
        ...(chain.pendingJoinRequests || []).map((entry) => idOf(entry.user)),
      ]);
      const addedIds = friendIds.filter((id) => !unavailableIds.has(id));
      if (!addedIds.length) {
        return response.status(409).json({ code: 'SHARED_CHAIN_ALREADY_INVITED', message: 'Những người được chọn đã ở trong nhóm hoặc đang chờ xác nhận.' });
      }
      if (!hasAvailableSeat(chain, addedIds.length)) {
        return response.status(409).json({ code: 'SHARED_CHAIN_MEMBER_LIMIT', message: `Nhóm chỉ có tối đa ${MAX_GROUP_MEMBERS} thành viên, kể cả lời mời/yêu cầu đang chờ.` });
      }
      const needsOwnerApproval = idOf(chain.owner) !== user._id.toString();
      const owner = needsOwnerApproval ? await User.findById(chain.owner).select('friends') : user;
      const ownerFriendIds = new Set((owner?.friends || []).map((friendId) => idOf(friendId)));
      const invitedAt = new Date();
      chain.pendingInvitations.push(...addedIds.map((id) => ({
        user: id,
        invitedBy: user._id,
        createdAt: invitedAt,
        awaitingOwnerApproval: needsOwnerApproval,
        isFriendOfOwner: ownerFriendIds.has(id),
      })));
      await chain.save();
      await populateChain(chain);
      if (needsOwnerApproval) {
        emitSharedChainEvent(chain.owner, 'shared-chain:invitation-review-request', { chainId: chain._id.toString() });
        void sendSharedChainInvitationReviewPushNotification({
          recipientId: chain.owner,
          sender: user,
          chainId: chain._id.toString(),
          chainTitle: chain.title,
        });
      } else {
        for (const invitedId of addedIds) {
          emitSharedChainEvent(invitedId, 'shared-chain:invitation', { chainId: chain._id.toString() });
          void sendSharedChainInvitationPushNotification({
            recipientId: invitedId,
            sender: user,
            chainId: chain._id.toString(),
            chainTitle: chain.title,
          });
        }
      }
      emitToMembers(chain, 'shared-chain:updated');
      return response.status(201).json({ chain: chainPayload(chain, user, isUserOnline), invitedIds: addedIds, awaitingOwnerApproval: needsOwnerApproval });
    } catch (error) {
      console.error('Create shared chain invitations failed:', error);
      return response.status(500).json({ code: 'CREATE_SHARED_CHAIN_INVITATION_FAILED', message: 'Không thể gửi lời mời vào nhóm.' });
    }
  });

  router.post('/shared-chains/:chainId/invitations/:memberId/review', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      if (!assertValidChainId(response, request.params.chainId) || !mongoose.isValidObjectId(request.params.memberId)) {
        if (mongoose.isValidObjectId(request.params.chainId)) response.status(404).json({ code: 'SHARED_CHAIN_INVITATION_NOT_FOUND', message: 'Không tìm thấy lời mời.' });
        return;
      }
      const action = request.body?.action;
      if (!['approve', 'decline'].includes(action)) {
        return response.status(422).json({ code: 'SHARED_CHAIN_INVITATION_REVIEW_ACTION_INVALID', message: 'Phản hồi lời mời không hợp lệ.' });
      }
      const chain = await SharedChain.findById(request.params.chainId);
      if (!chain) return response.status(404).json({ code: 'SHARED_CHAIN_NOT_FOUND', message: 'Nhóm không còn tồn tại.' });
      if (idOf(chain.owner) !== user._id.toString()) {
        return response.status(403).json({ code: 'SHARED_CHAIN_MANAGE_FORBIDDEN', message: 'Chỉ chủ nhóm mới có thể duyệt lời mời này.' });
      }
      const invitationIndex = (chain.pendingInvitations || []).findIndex((entry) => idOf(entry.user) === request.params.memberId && entry.awaitingOwnerApproval);
      if (invitationIndex < 0) return response.status(404).json({ code: 'SHARED_CHAIN_INVITATION_NOT_FOUND', message: 'Đề xuất mời này không còn hiệu lực.' });
      const invitation = chain.pendingInvitations[invitationIndex];
      let createdFriendRequest = null;
      let friendshipTarget = null;
      if (action === 'approve') {
        const target = await User.findById(request.params.memberId).select('blockedUsers');
        if (!target) return response.status(404).json({ code: 'USER_NOT_FOUND', message: 'Người được mời không còn tồn tại.' });
        friendshipTarget = target;
        const areFriends = (user.friends || []).some((friendId) => idOf(friendId) === target._id.toString());
        invitation.awaitingOwnerApproval = false;
        invitation.isFriendOfOwner = areFriends;
        invitation.awaitingFriendship = !areFriends;
        if (!areFriends) {
          if ((user.blockedUsers || []).some((blockedUserId) => idOf(blockedUserId) === target._id.toString())
            || (target.blockedUsers || []).some((blockedUserId) => idOf(blockedUserId) === user._id.toString())) {
            return response.status(403).json({ code: 'USER_BLOCKED', message: 'Không thể gửi lời mời kết bạn do một trong hai tài khoản đã chặn nhau.' });
          }
          const pairKey = friendPairKey(user._id, target._id);
          let friendRequest = await FriendRequest.findOne({ pairKey });
          if (!friendRequest) {
            try {
              friendRequest = await FriendRequest.create({ from: user._id, to: target._id, pairKey });
              createdFriendRequest = friendRequest;
            } catch (error) {
              if (error?.code === 11000) friendRequest = await FriendRequest.findOne({ pairKey });
              else throw error;
            }
          }
          if (!friendRequest) throw new Error('Could not create the required friendship request.');
          invitation.friendRequest = friendRequest._id;
        } else {
          invitation.friendRequest = null;
        }
      } else {
        chain.pendingInvitations.splice(invitationIndex, 1);
      }
      await chain.save();
      await populateChain(chain);
      emitToMembers(chain, 'shared-chain:updated');
      emitSharedChainEvent(invitation.invitedBy, 'shared-chain:invitation-review-resolved', { chainId: chain._id.toString(), memberId: request.params.memberId, action });
      if (createdFriendRequest && friendshipTarget) {
        emitSharedChainEvent(user._id, 'social:friends-updated', { reason: 'shared_chain_friend_request_sent' });
        emitSharedChainEvent(friendshipTarget._id, 'social:friend-request-received', {
          requestId: createdFriendRequest.id,
          from: userPayload(user, isUserOnline),
        });
        void sendFriendRequestPushNotification({ recipientId: friendshipTarget._id, sender: user, requestId: createdFriendRequest.id });
      }
      if (action === 'approve' && !invitation.awaitingFriendship) {
        emitSharedChainEvent(request.params.memberId, 'shared-chain:invitation', { chainId: chain._id.toString() });
        void sendSharedChainInvitationPushNotification({
          recipientId: request.params.memberId,
          sender: user,
          chainId: chain._id.toString(),
          chainTitle: chain.title,
        });
      }
      return response.json({ ok: true, action, chain: chainPayload(chain, user, isUserOnline) });
    } catch (error) {
      console.error('Review shared chain invitation failed:', error);
      return response.status(500).json({ code: 'REVIEW_SHARED_CHAIN_INVITATION_FAILED', message: 'Không thể xử lý đề xuất mời vào nhóm.' });
    }
  });

  router.get('/shared-chains/:chainId/join-requests', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      if (!assertValidChainId(response, request.params.chainId)) return;
      const chain = await SharedChain.findById(request.params.chainId);
      if (!chain) return response.status(404).json({ code: 'SHARED_CHAIN_NOT_FOUND', message: 'Nhóm không còn tồn tại.' });
      if (idOf(chain.owner) !== user._id.toString()) {
        return response.status(403).json({ code: 'SHARED_CHAIN_MANAGE_FORBIDDEN', message: 'Chỉ chủ nhóm mới xem được các yêu cầu tham gia.' });
      }
      await populateChain(chain);
      const requests = (chain.pendingJoinRequests || []).filter((entry) => entry.user).map((entry) => ({
        user: userPayload(entry.user, isUserOnline),
        requestedAt: new Date(entry.requestedAt).toISOString(),
      }));
      return response.json({ requests });
    } catch (error) {
      console.error('Get shared chain join requests failed:', error);
      return response.status(500).json({ code: 'GET_SHARED_CHAIN_JOIN_REQUESTS_FAILED', message: 'Không thể tải yêu cầu tham gia.' });
    }
  });

  router.post('/shared-chains/:chainId/join-requests/:memberId/respond', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      if (!assertValidChainId(response, request.params.chainId) || !mongoose.isValidObjectId(request.params.memberId)) {
        if (mongoose.isValidObjectId(request.params.chainId)) response.status(404).json({ code: 'SHARED_CHAIN_JOIN_REQUEST_NOT_FOUND', message: 'Không tìm thấy yêu cầu tham gia.' });
        return;
      }
      const action = request.body?.action;
      if (!['approve', 'decline'].includes(action)) {
        return response.status(422).json({ code: 'SHARED_CHAIN_JOIN_REQUEST_ACTION_INVALID', message: 'Phản hồi yêu cầu không hợp lệ.' });
      }
      const chain = await SharedChain.findById(request.params.chainId);
      if (!chain) return response.status(404).json({ code: 'SHARED_CHAIN_NOT_FOUND', message: 'Nhóm không còn tồn tại.' });
      if (idOf(chain.owner) !== user._id.toString()) {
        return response.status(403).json({ code: 'SHARED_CHAIN_MANAGE_FORBIDDEN', message: 'Chỉ chủ nhóm mới có thể duyệt thành viên.' });
      }
      const requestIndex = (chain.pendingJoinRequests || []).findIndex((entry) => idOf(entry.user) === request.params.memberId);
      if (requestIndex < 0) return response.status(404).json({ code: 'SHARED_CHAIN_JOIN_REQUEST_NOT_FOUND', message: 'Yêu cầu này không còn hiệu lực.' });
      if (action === 'approve' && !isCurrentMember(chain, request.params.memberId) && (chain.members || []).length >= MAX_GROUP_MEMBERS) {
        return response.status(409).json({ code: 'SHARED_CHAIN_MEMBER_LIMIT', message: `Nhóm này đã đủ ${MAX_GROUP_MEMBERS} thành viên.` });
      }
      chain.pendingJoinRequests.splice(requestIndex, 1);
      if (action === 'approve' && !isCurrentMember(chain, request.params.memberId)) {
        chain.members.push({ user: request.params.memberId, joinedAt: new Date() });
      }
      await chain.save();
      await populateChain(chain);
      emitToMembers(chain, 'shared-chain:updated');
      emitSharedChainEvent(request.params.memberId, 'shared-chain:join-request-resolved', { chainId: chain._id.toString(), action });
      return response.json({ ok: true, action, chain: chainPayload(chain, user, isUserOnline) });
    } catch (error) {
      console.error('Respond shared chain join request failed:', error);
      return response.status(500).json({ code: 'RESPOND_SHARED_CHAIN_JOIN_REQUEST_FAILED', message: 'Không thể xử lý yêu cầu tham gia.' });
    }
  });

  router.delete('/shared-chains/:chainId/join-requests/me', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      if (!assertValidChainId(response, request.params.chainId)) return;
      const chain = await SharedChain.findById(request.params.chainId);
      if (!chain) return response.status(404).json({ code: 'SHARED_CHAIN_NOT_FOUND', message: 'Nhóm không còn tồn tại.' });
      const requestIndex = (chain.pendingJoinRequests || []).findIndex((entry) => idOf(entry.user) === user._id.toString());
      if (requestIndex < 0) return response.status(404).json({ code: 'SHARED_CHAIN_JOIN_REQUEST_NOT_FOUND', message: 'Yêu cầu này không còn hiệu lực.' });
      chain.pendingJoinRequests.splice(requestIndex, 1);
      await chain.save();
      emitToMembers(chain, 'shared-chain:updated', { cancelledJoinRequestId: user._id.toString() });
      emitSharedChainEvent(user._id, 'shared-chain:join-request-cancelled', { chainId: chain._id.toString() });
      return response.json({ ok: true, chainId: chain._id.toString() });
    } catch (error) {
      console.error('Cancel shared chain join request failed:', error);
      return response.status(500).json({ code: 'CANCEL_SHARED_CHAIN_JOIN_REQUEST_FAILED', message: 'Không thể hủy yêu cầu tham gia lúc này.' });
    }
  });

  router.post('/shared-chains/:chainId/leave', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const chain = await findMemberChain(request.params.chainId, user, response);
      if (!chain) return;
      if (idOf(chain.owner) === user._id.toString()) {
        return response.status(422).json({ code: 'SHARED_CHAIN_OWNER_LEAVE_FORBIDDEN', message: 'Chủ nhóm chỉ có thể xóa nhóm, không thể tự rời nhóm.' });
      }
      chain.members = chain.members.filter((member) => idOf(member.user) !== user._id.toString());
      await chain.save();
      await populateChain(chain);
      emitToMembers(chain, 'shared-chain:updated', { leftMemberId: user._id.toString() });
      emitSharedChainEvent(user._id, 'shared-chain:left', { chainId: chain._id.toString() });
      return response.json({ ok: true, chainId: chain._id.toString() });
    } catch (error) {
      console.error('Leave shared chain failed:', error);
      return response.status(500).json({ code: 'LEAVE_SHARED_CHAIN_FAILED', message: 'Không thể rời nhóm lúc này.' });
    }
  });

  router.delete('/shared-chains/:chainId', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      if (!assertValidChainId(response, request.params.chainId)) return;
      const chain = await SharedChain.findById(request.params.chainId);
      if (!chain) return response.status(404).json({ code: 'SHARED_CHAIN_NOT_FOUND', message: 'Nhóm không còn tồn tại.' });
      if (idOf(chain.owner) !== user._id.toString()) {
        return response.status(403).json({ code: 'SHARED_CHAIN_MANAGE_FORBIDDEN', message: 'Chỉ chủ nhóm mới có thể xóa nhóm.' });
      }
      const deletedChainId = chain._id.toString();
      const avatarPath = chain.avatarPath;
      const recipients = new Set([
        ...(chain.members || []).map((member) => idOf(member.user)),
        ...(chain.pendingInvitations || []).map((entry) => idOf(entry.user)),
        ...(chain.pendingJoinRequests || []).map((entry) => idOf(entry.user)),
      ].filter(Boolean));
      const deleteResult = await SharedChain.deleteOne({ _id: chain._id, owner: user._id });
      if (deleteResult.deletedCount !== 1) {
        return response.status(409).json({ code: 'SHARED_CHAIN_DELETE_CONFLICT', message: 'Nhóm vừa thay đổi. Vui lòng tải lại và thử lại.' });
      }
      await removeLocalGroupAvatar(avatarPath);
      for (const recipientId of recipients) {
        emitSharedChainEvent(recipientId, 'shared-chain:deleted', { chainId: deletedChainId, deletedBy: user._id.toString() });
      }
      return response.json({ ok: true, chainId: deletedChainId });
    } catch (error) {
      console.error('Delete shared chain failed:', error);
      return response.status(500).json({ code: 'DELETE_SHARED_CHAIN_FAILED', message: 'Không thể xóa nhóm lúc này.' });
    }
  });

  router.delete('/shared-chains/:chainId/members/:memberId', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      if (!assertValidChainId(response, request.params.chainId) || !mongoose.isValidObjectId(request.params.memberId)) {
        if (mongoose.isValidObjectId(request.params.chainId)) response.status(404).json({ code: 'SHARED_CHAIN_MEMBER_NOT_FOUND', message: 'Không tìm thấy thành viên.' });
        return;
      }
      const chain = await SharedChain.findById(request.params.chainId);
      if (!chain) return response.status(404).json({ code: 'SHARED_CHAIN_NOT_FOUND', message: 'Nhóm không còn tồn tại.' });
      if (idOf(chain.owner) !== user._id.toString()) {
        return response.status(403).json({ code: 'SHARED_CHAIN_MANAGE_FORBIDDEN', message: 'Chỉ chủ nhóm mới có thể quản lý thành viên.' });
      }
      if (request.params.memberId === user._id.toString()) {
        return response.status(422).json({ code: 'SHARED_CHAIN_OWNER_REMOVE_FORBIDDEN', message: 'Chủ nhóm không thể tự xóa mình.' });
      }
      const before = chain.members.length;
      chain.members = chain.members.filter((member) => idOf(member.user) !== request.params.memberId);
      if (chain.members.length === before) return response.status(404).json({ code: 'SHARED_CHAIN_MEMBER_NOT_FOUND', message: 'Người này không còn trong nhóm.' });
      await chain.save();
      await populateChain(chain);
      emitToMembers(chain, 'shared-chain:updated', { removedMemberId: request.params.memberId });
      emitSharedChainEvent(request.params.memberId, 'shared-chain:updated', { chainId: chain._id.toString(), removedMemberId: request.params.memberId });
      return response.json({ ok: true, chain: chainPayload(chain, user, isUserOnline) });
    } catch (error) {
      console.error('Remove shared chain member failed:', error);
      return response.status(500).json({ code: 'REMOVE_SHARED_CHAIN_MEMBER_FAILED', message: 'Không thể xóa thành viên khỏi nhóm.' });
    }
  });

  return router;
}
