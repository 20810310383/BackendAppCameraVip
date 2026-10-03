import { Router } from 'express';
import { FriendRequest } from '../models/FriendRequest.js';
import { SharedChain } from '../models/SharedChain.js';
import { Session } from '../models/Session.js';
import { User } from '../models/User.js';
import { sendFriendRequestPushNotification, sendSharedChainInvitationPushNotification } from '../services/push-service.js';
import { hashSessionToken } from '../services/session-service.js';
import { normalizeUsername, usernameIsValid } from '../services/username-service.js';

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

function lastActiveLabel(lastActiveAt) {
  if (!lastActiveAt) return 'Hoạt động trước đây';
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - lastActiveAt.getTime()) / 60_000));
  if (elapsedMinutes < 1) return 'Hoạt động vừa xong';
  if (elapsedMinutes < 60) return `Hoạt động ${elapsedMinutes} phút trước`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `Hoạt động ${elapsedHours} giờ trước`;
  return `Hoạt động ${Math.floor(elapsedHours / 24)} ngày trước`;
}

function userSummary(user, isUserOnline) {
  return {
    id: user.id || user._id.toString(),
    fullName: user.fullName,
    username: user.username,
    avatarPath: user.avatarPath || '',
    isOnline: Boolean(isUserOnline(user._id)),
    lastActiveAt: user.lastActiveAt ? user.lastActiveAt.toISOString() : null,
    activityLabel: isUserOnline(user._id) ? 'Đang hoạt động' : lastActiveLabel(user.lastActiveAt),
  };
}

function friendPairKey(firstUserId, secondUserId) {
  return [firstUserId.toString(), secondUserId.toString()].sort().join(':');
}

function idOf(value) {
  return value?._id?.toString?.() || value?.id?.toString?.() || value?.toString?.() || '';
}

async function friendList(userId, isUserOnline) {
  const [user, outgoingRequests, incomingRequests] = await Promise.all([
    User.findById(userId).populate({
      path: 'friends',
      select: 'fullName username lastActiveAt avatarPath',
      options: { sort: { fullName: 1 } },
    }),
    FriendRequest.find({ from: userId })
      .populate({ path: 'to', select: 'fullName username lastActiveAt avatarPath' })
      .sort({ createdAt: -1 }),
    FriendRequest.find({ to: userId })
      .populate({ path: 'from', select: 'fullName username lastActiveAt avatarPath' })
      .sort({ createdAt: -1 }),
  ]);
  const friends = (user?.friends || []).filter(Boolean).map((friend) => userSummary(friend, isUserOnline));

  return {
    friends,
    total: friends.length,
    outgoingRequests: outgoingRequests.filter((request) => request.to).map((request) => ({
      id: request.id,
      user: userSummary(request.to, isUserOnline),
      status: request.status,
      createdAt: request.createdAt.toISOString(),
    })),
    incomingRequests: incomingRequests.filter((request) => request.from).map((request) => ({
      id: request.id,
      user: userSummary(request.from, isUserOnline),
      status: request.status,
      createdAt: request.createdAt.toISOString(),
    })),
  };
}

async function incomingRequestList(userId, isUserOnline) {
  const requests = await FriendRequest.find({ to: userId })
    .populate({ path: 'from', select: 'fullName username lastActiveAt avatarPath' })
    .sort({ createdAt: -1 });

  return {
    requests: requests.filter((request) => request.from).map((request) => ({
      id: request.id,
      user: userSummary(request.from, isUserOnline),
      status: request.status,
      createdAt: request.createdAt.toISOString(),
    })),
  };
}

async function blockedUserList(userId, isUserOnline) {
  const user = await User.findById(userId).populate({
    path: 'blockedUsers',
    select: 'fullName username lastActiveAt avatarPath',
    options: { sort: { fullName: 1 } },
  });
  return (user?.blockedUsers || []).filter(Boolean).map((blocked) => userSummary(blocked, isUserOnline));
}

export function createSocialRouter({
  isDatabaseReady,
  emitSocialEvent = () => undefined,
  isUserOnline = () => false,
}) {
  const router = Router();

  const emitSharedChainUpdate = (chain) => {
    const recipients = new Set([
      idOf(chain.owner),
      ...(chain.members || []).map((member) => idOf(member.user)),
      ...(chain.pendingInvitations || []).map((invitation) => idOf(invitation.user)),
      ...(chain.pendingJoinRequests || []).map((joinRequest) => idOf(joinRequest.user)),
    ].filter(Boolean));
    for (const recipientId of recipients) emitSocialEvent(recipientId, 'shared-chain:updated', { chainId: chain._id.toString() });
  };

  const releaseSharedChainInvitationsAfterFriendship = async (friendRequestId) => {
    const chains = await SharedChain.find({
      pendingInvitations: { $elemMatch: { awaitingFriendship: true, friendRequest: friendRequestId } },
    });
    for (const chain of chains) {
      const invitedUserIds = [];
      for (const invitation of chain.pendingInvitations || []) {
        if (!invitation.awaitingFriendship || idOf(invitation.friendRequest) !== friendRequestId.toString()) continue;
        invitation.awaitingFriendship = false;
        invitation.isFriendOfOwner = true;
        invitation.friendRequest = null;
        invitedUserIds.push(idOf(invitation.user));
      }
      if (!invitedUserIds.length) continue;
      // eslint-disable-next-line no-await-in-loop
      await chain.save();
      emitSharedChainUpdate(chain);
      for (const invitedUserId of invitedUserIds) {
        emitSocialEvent(invitedUserId, 'shared-chain:invitation', { chainId: chain._id.toString() });
        void sendSharedChainInvitationPushNotification({
          recipientId: invitedUserId,
          chainId: chain._id.toString(),
          chainTitle: chain.title,
        });
      }
    }
  };

  const discardSharedChainInvitationsForFriendRequest = async (friendRequestId) => {
    const chains = await SharedChain.find({
      pendingInvitations: { $elemMatch: { awaitingFriendship: true, friendRequest: friendRequestId } },
    });
    for (const chain of chains) {
      const originalCount = (chain.pendingInvitations || []).length;
      chain.pendingInvitations = (chain.pendingInvitations || []).filter((invitation) => (
        !invitation.awaitingFriendship || idOf(invitation.friendRequest) !== friendRequestId.toString()
      ));
      if (chain.pendingInvitations.length === originalCount) continue;
      // eslint-disable-next-line no-await-in-loop
      await chain.save();
      emitSharedChainUpdate(chain);
    }
  };

  const handleBlockUser = async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const targetUserId = request.params.targetUserId || request.params.friendId;
      const targetUser = await User.findById(targetUserId);
      if (!targetUser) {
        return response.status(404).json({ code: 'USER_NOT_FOUND', message: 'Người dùng không tồn tại.' });
      }
      if (targetUser._id.equals(user._id)) {
        return response.status(422).json({ code: 'CANNOT_BLOCK_SELF', message: 'Bạn không thể tự chặn chính mình.' });
      }

      await Promise.all([
        User.updateOne(
          { _id: user._id },
          { $addToSet: { blockedUsers: targetUser._id }, $pull: { friends: targetUser._id, locationSharingRecipientIds: targetUser._id } },
        ),
        User.updateOne({ _id: targetUser._id }, { $pull: { friends: user._id, locationSharingRecipientIds: user._id } }),
        FriendRequest.deleteMany({
          $or: [
            { from: user._id, to: targetUser._id },
            { from: targetUser._id, to: user._id },
          ],
        }),
      ]);
      emitSocialEvent(user._id, 'social:friends-updated', { reason: 'friend_blocked' });
      emitSocialEvent(user._id, 'social:blocked-users-updated', {});
      emitSocialEvent(targetUser._id, 'social:friend-removed', { userId: user._id.toString(), reason: 'friend_blocked' });
      emitSocialEvent(targetUser._id, 'social:friends-updated', { reason: 'friend_blocked' });
      return response.json({
        message: `Đã chặn @${targetUser.username}.`,
        ...(await friendList(user._id, isUserOnline)),
      });
    } catch (error) {
      console.error('Block user failed:', error);
      return response.status(500).json({ code: 'BLOCK_USER_FAILED', message: 'Không thể chặn người dùng lúc này.' });
    }
  };

  const handleUnblockUser = async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const targetUserId = request.params.targetUserId;
      const targetUser = await User.findById(targetUserId);
      if (!targetUser) {
        return response.status(404).json({ code: 'USER_NOT_FOUND', message: 'Người dùng không tồn tại.' });
      }

      await User.updateOne({ _id: user._id }, { $pull: { blockedUsers: targetUser._id } });
      emitSocialEvent(user._id, 'social:blocked-users-updated', {});
      return response.json({
        message: `Đã huỷ chặn @${targetUser.username}.`,
        blockedUsers: await blockedUserList(user._id, isUserOnline),
      });
    } catch (error) {
      console.error('Unblock user failed:', error);
      return response.status(500).json({ code: 'UNBLOCK_USER_FAILED', message: 'Không thể huỷ chặn lúc này.' });
    }
  };

  router.get('/users/blocked', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const blocked = await blockedUserList(user._id, isUserOnline);
      return response.json({ blockedUsers: blocked });
    } catch (error) {
      console.error('Get blocked users failed:', error);
      return response.status(500).json({ code: 'GET_BLOCKED_USERS_FAILED', message: 'Không thể tải danh sách chặn.' });
    }
  });

  router.post('/friends/:friendId/block', handleBlockUser);
  router.post('/users/:targetUserId/block', handleBlockUser);
  router.post('/users/:targetUserId/unblock', handleUnblockUser);
  router.delete('/users/:targetUserId/block', handleUnblockUser);

  router.patch('/users/me/username', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);

    const username = normalizeUsername(request.body?.username);
    if (!usernameIsValid(username)) {
      return response.status(422).json({
        code: 'VALIDATION_ERROR',
        errors: { username: 'Username gồm 3–24 ký tự: chữ thường, số hoặc dấu gạch dưới.' },
      });
    }

    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      if (user.username === username) return response.json({ user: user.toJSON() });

      user.username = username;
      await user.save();
      user.friends.forEach((friendId) => emitSocialEvent(friendId, 'social:friends-updated', { reason: 'profile_updated' }));
      return response.json({ message: 'Đã cập nhật username.', user: user.toJSON() });
    } catch (error) {
      if (error?.code === 11000) {
        return response.status(409).json({
          code: 'USERNAME_EXISTS',
          errors: { username: 'Username này đã được sử dụng.' },
        });
      }
      console.error('Update username failed:', error);
      return response.status(500).json({
        code: 'UPDATE_USERNAME_FAILED',
        message: 'Không thể cập nhật username lúc này.',
      });
    }
  });

  router.get('/friends', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      return response.json(await friendList(user._id, isUserOnline));
    } catch (error) {
      console.error('Get friends failed:', error);
      return response.status(500).json({ code: 'GET_FRIENDS_FAILED', message: 'Không thể tải danh sách bạn bè.' });
    }
  });

  router.delete('/friends/:friendId', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const friend = await User.findById(request.params.friendId);
      if (!friend || !(user.friends || []).some((friendId) => friendId.equals(friend._id))) {
        return response.status(404).json({ code: 'FRIEND_NOT_FOUND', message: 'Người này không còn trong danh sách bạn bè.' });
      }

      await Promise.all([
        User.updateOne({ _id: user._id }, { $pull: { friends: friend._id, locationSharingRecipientIds: friend._id } }),
        User.updateOne({ _id: friend._id }, { $pull: { friends: user._id, locationSharingRecipientIds: user._id } }),
      ]);
      emitSocialEvent(user._id, 'social:friends-updated', { reason: 'friend_removed' });
      emitSocialEvent(friend._id, 'social:friend-removed', { userId: user._id.toString() });
      return response.json({
        message: `Đã xoá @${friend.username} khỏi danh sách bạn bè.`,
        ...(await friendList(user._id, isUserOnline)),
      });
    } catch (error) {
      console.error('Remove friend failed:', error);
      return response.status(500).json({ code: 'REMOVE_FRIEND_FAILED', message: 'Không thể xoá bạn bè lúc này.' });
    }
  });

  router.post('/friends/:friendId/block', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const friend = await User.findById(request.params.friendId);
      if (!friend || !(user.friends || []).some((friendId) => friendId.equals(friend._id))) {
        return response.status(404).json({ code: 'FRIEND_NOT_FOUND', message: 'Người này không còn trong danh sách bạn bè.' });
      }

      await Promise.all([
        User.updateOne(
          { _id: user._id },
          { $addToSet: { blockedUsers: friend._id }, $pull: { friends: friend._id, locationSharingRecipientIds: friend._id } },
        ),
        User.updateOne({ _id: friend._id }, { $pull: { friends: user._id, locationSharingRecipientIds: user._id } }),
        FriendRequest.deleteMany({
          $or: [
            { from: user._id, to: friend._id },
            { from: friend._id, to: user._id },
          ],
        }),
      ]);
      emitSocialEvent(user._id, 'social:friends-updated', { reason: 'friend_blocked' });
      emitSocialEvent(friend._id, 'social:friend-removed', { userId: user._id.toString(), reason: 'friend_blocked' });
      return response.json({
        message: `Đã chặn @${friend.username}.`,
        ...(await friendList(user._id, isUserOnline)),
      });
    } catch (error) {
      console.error('Block friend failed:', error);
      return response.status(500).json({ code: 'BLOCK_FRIEND_FAILED', message: 'Không thể chặn người dùng lúc này.' });
    }
  });

  router.post('/friend-requests', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);

    const username = normalizeUsername(request.body?.username);
    if (!usernameIsValid(username)) {
      return response.status(422).json({
        code: 'VALIDATION_ERROR',
        errors: { username: 'Nhập username hợp lệ để gửi lời mời.' },
      });
    }

    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const friend = await User.findOne({ username });
      if (!friend) {
        return response.status(404).json({
          code: 'USERNAME_NOT_FOUND',
          errors: { username: 'Không tìm thấy người dùng với username này.' },
        });
      }
      if (friend._id.equals(user._id)) {
        return response.status(422).json({
          code: 'CANNOT_ADD_SELF',
          errors: { username: 'Bạn không thể thêm chính mình.' },
        });
      }
      if ((user.blockedUsers || []).some((blockedUserId) => blockedUserId.equals(friend._id))
        || (friend.blockedUsers || []).some((blockedUserId) => blockedUserId.equals(user._id))) {
        return response.status(403).json({
          code: 'USER_BLOCKED',
          errors: { username: 'Bạn không thể gửi lời mời tới người dùng này.' },
        });
      }
      if ((user.friends || []).some((friendId) => friendId.equals(friend._id))) {
        return response.status(409).json({
          code: 'ALREADY_FRIENDS',
          errors: { username: 'Người này đã là bạn của bạn.' },
        });
      }

      const pairKey = friendPairKey(user._id, friend._id);
      const existingRequest = await FriendRequest.findOne({ pairKey });
      if (existingRequest) {
        const isOutgoing = existingRequest.from.equals(user._id);
        return response.status(409).json({
          code: isOutgoing ? 'FRIEND_REQUEST_ALREADY_SENT' : 'FRIEND_REQUEST_RECEIVED',
          errors: {
            username: isOutgoing
              ? 'Bạn đã gửi lời mời tới người này. Chờ họ xác nhận.'
              : 'Người này đã gửi lời mời cho bạn. Hãy xác nhận trong Cài đặt.',
          },
        });
      }

      let friendRequest;
      try {
        friendRequest = await FriendRequest.create({ from: user._id, to: friend._id, pairKey });
      } catch (error) {
        if (error?.code === 11000) {
          return response.status(409).json({
            code: 'FRIEND_REQUEST_ALREADY_SENT',
            errors: { username: 'Bạn đã gửi lời mời tới người này. Chờ họ xác nhận.' },
          });
        }
        throw error;
      }

      emitSocialEvent(user._id, 'social:friends-updated', { reason: 'friend_request_sent' });
      emitSocialEvent(friend._id, 'social:friend-request-received', {
        requestId: friendRequest.id,
        from: userSummary(user, isUserOnline),
      });
      void sendFriendRequestPushNotification({ recipientId: friend._id, sender: user, requestId: friendRequest.id });
      return response.status(201).json({
        message: `Đã gửi lời mời tới @${friend.username}.`,
        ...(await friendList(user._id, isUserOnline)),
      });
    } catch (error) {
      console.error('Create friend request failed:', error);
      return response.status(500).json({ code: 'CREATE_FRIEND_REQUEST_FAILED', message: 'Không thể gửi lời mời lúc này.' });
    }
  });

  router.get('/friend-requests/incoming', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      return response.json(await incomingRequestList(user._id, isUserOnline));
    } catch (error) {
      console.error('Get incoming friend requests failed:', error);
      return response.status(500).json({ code: 'GET_FRIEND_REQUESTS_FAILED', message: 'Không thể tải lời mời kết bạn.' });
    }
  });

  router.post('/friend-requests/:requestId/accept', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const friendRequest = await FriendRequest.findOne({ _id: request.params.requestId, to: user._id });
      if (!friendRequest) {
        return response.status(404).json({ code: 'FRIEND_REQUEST_NOT_FOUND', message: 'Lời mời này không còn tồn tại.' });
      }

      await Promise.all([
        User.updateOne({ _id: user._id }, { $addToSet: { friends: friendRequest.from } }),
        User.updateOne({ _id: friendRequest.from }, { $addToSet: { friends: user._id } }),
        FriendRequest.deleteOne({ _id: friendRequest._id }),
      ]);
      await releaseSharedChainInvitationsAfterFriendship(friendRequest._id);
      emitSocialEvent(user._id, 'social:friends-updated', { reason: 'friend_request_accepted' });
      emitSocialEvent(friendRequest.from, 'social:friend-request-accepted', { userId: user._id.toString() });
      return response.json({
        message: 'Đã xác nhận lời mời kết bạn.',
        ...(await incomingRequestList(user._id, isUserOnline)),
      });
    } catch (error) {
      console.error('Accept friend request failed:', error);
      return response.status(500).json({ code: 'ACCEPT_FRIEND_REQUEST_FAILED', message: 'Không thể xác nhận lời mời lúc này.' });
    }
  });

  router.delete('/friend-requests/:requestId', async (request, response) => {
    if (!isDatabaseReady()) return databaseUnavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const deleted = await FriendRequest.findOneAndDelete({
        _id: request.params.requestId,
        $or: [{ from: user._id }, { to: user._id }],
      });
      if (!deleted) {
        return response.status(404).json({ code: 'FRIEND_REQUEST_NOT_FOUND', message: 'Lời mời này không còn tồn tại.' });
      }
      const wasSender = deleted.from.equals(user._id);
      const otherUserId = wasSender ? deleted.to : deleted.from;
      await discardSharedChainInvitationsForFriendRequest(deleted._id);
      emitSocialEvent(user._id, 'social:friends-updated', { reason: wasSender ? 'friend_request_cancelled' : 'friend_request_declined' });
      emitSocialEvent(otherUserId, 'social:friends-updated', { reason: wasSender ? 'friend_request_cancelled' : 'friend_request_declined' });
      return response.json({
        message: wasSender ? 'Đã huỷ lời mời kết bạn.' : 'Đã từ chối lời mời kết bạn.',
        ...(await friendList(user._id, isUserOnline)),
      });
    } catch (error) {
      console.error('Delete friend request failed:', error);
      return response.status(500).json({ code: 'DELETE_FRIEND_REQUEST_FAILED', message: 'Không thể cập nhật lời mời lúc này.' });
    }
  });

  return router;
}
