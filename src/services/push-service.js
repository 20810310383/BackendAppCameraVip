import { request as httpsRequest } from 'node:https';
import { FriendRequest } from '../models/FriendRequest.js';
import { Message } from '../models/Message.js';
import { SharedChain } from '../models/SharedChain.js';
import { User } from '../models/User.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_PUSH_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const EXPO_PUSH_TOKEN = /^(?:ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/;
const PUSH_REQUEST_TIMEOUT_MS = 12_000;
const PUSH_RETRY_DELAYS_MS = [500, 1_500];
const PUSH_RECEIPT_DELAYS_MS = [15_000, 60_000, 5 * 60_000];

function androidMessageChannelId(preferences) {
  return `messages-${preferences.sound ? 'sound' : 'silent'}-${preferences.vibration ? 'vibrate' : 'quiet'}`;
}

export const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({
  pushEnabled: true,
  messages: true,
  friendRequests: true,
  groupActivity: true,
  sound: true,
  vibration: true,
  badges: true,
});

export function getNotificationPreferences(user) {
  const savedDocument = user?.notificationPreferences;
  const saved = typeof savedDocument?.toObject === 'function' ? savedDocument.toObject() : savedDocument;
  return {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    ...(saved && typeof saved === 'object' ? saved : {}),
  };
}

function previewFor(message) {
  if (message.type === 'image') return 'Đã gửi một ảnh 📷';
  if (message.type === 'audio') return 'Đã gửi một tin nhắn thoại 🎙️';
  if (message.type === 'emoji') return message.text || 'Đã gửi một biểu tượng cảm xúc';
  return message.text || 'Bạn có một tin nhắn mới';
}

export function isExpoPushToken(value) {
  return typeof value === 'string' && EXPO_PUSH_TOKEN.test(value);
}

function expoHeaders() {
  const accessToken = process.env.EXPO_ACCESS_TOKEN?.trim();
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json; charset=utf-8',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function postToExpo(url, payload) {
  let lastError;
  for (let attempt = 0; attempt <= PUSH_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await postJsonToExpo(url, payload);
    } catch (error) {
      lastError = error;
      if (error?.status && error.status !== 429 && error.status < 500) throw error;
    }
    const retryDelay = PUSH_RETRY_DELAYS_MS[attempt];
    if (retryDelay !== undefined) await wait(retryDelay);
  }
  throw lastError || new Error('Expo Push Service không phản hồi.');
}

function postJsonToExpo(url, payload) {
  const requestBody = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: 'POST',
      headers: {
        ...expoHeaders(),
        'Content-Length': Buffer.byteLength(requestBody),
      },
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.once('error', reject);
      response.once('end', () => {
        let body = {};
        try {
          body = responseBody ? JSON.parse(responseBody) : {};
        } catch {
          const error = new Error('Expo Push Service trả về dữ liệu không hợp lệ.');
          error.status = response.statusCode || 502;
          reject(error);
          return;
        }

        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(body);
          return;
        }

        const message = body?.errors?.[0]?.message || body?.message || response.statusMessage || `HTTP ${response.statusCode || 500}`;
        const error = new Error(message);
        error.status = response.statusCode || 500;
        reject(error);
      });
    });

    request.once('error', reject);
    request.setTimeout(PUSH_REQUEST_TIMEOUT_MS, () => request.destroy(new Error('Expo Push Service quá thời gian phản hồi.')));
    request.end(requestBody);
  });
}

async function removeInvalidTokens(recipientId, tokens) {
  if (!tokens.length) return;
  await User.updateOne({ _id: recipientId }, { $pull: { expoPushTokens: { token: { $in: [...new Set(tokens)] } } } });
}

function scheduleReceiptCheck({ recipientId, receiptTokens, logLabel, attempt = 0 }) {
  const delay = PUSH_RECEIPT_DELAYS_MS[attempt];
  if (delay === undefined || !receiptTokens.size) return;
  const timer = setTimeout(async () => {
    try {
      const receiptIds = [...receiptTokens.keys()];
      const body = await postToExpo(EXPO_PUSH_RECEIPTS_URL, { ids: receiptIds });
      const receipts = body?.data || {};
      const invalidTokens = [];
      const pendingReceipts = new Map();
      for (const [receiptId, token] of receiptTokens) {
        const receipt = receipts[receiptId];
        if (!receipt) {
          pendingReceipts.set(receiptId, token);
          continue;
        }
        if (receipt.status !== 'error') continue;
        const errorCode = receipt.details?.error || 'UnknownError';
        console.warn(`Expo ${logLabel} push receipt failed (${errorCode}): ${receipt.message || 'Không rõ lỗi'}`);
        if (errorCode === 'DeviceNotRegistered') invalidTokens.push(token);
      }
      await removeInvalidTokens(recipientId, invalidTokens);
      scheduleReceiptCheck({ recipientId, receiptTokens: pendingReceipts, logLabel, attempt: attempt + 1 });
    } catch (error) {
      console.warn(`Could not check ${logLabel} push receipts: ${error.message}`);
      scheduleReceiptCheck({ recipientId, receiptTokens, logLabel, attempt: attempt + 1 });
    }
  }, delay);
  timer.unref?.();
}

function sameUserId(value, recipientId) {
  return value?.toString() === recipientId.toString();
}

/**
 * Count every outstanding item that is actionable by the recipient.  This is
 * deliberately shared by the push payload and the client-side badge refresh
 * endpoint so an opened app cannot overwrite a correct APNs badge with a
 * messages-only value.
 */
export async function getRecipientBadgeCount(recipientId) {
  const [unreadMessages, pendingRequests, sharedChains] = await Promise.all([
    Message.countDocuments({
      recipient: recipientId,
      readAt: null,
      deletedFor: { $ne: recipientId },
    }),
    FriendRequest.countDocuments({
      to: recipientId,
      status: 'pending',
    }),
    // A user owns at most 12 groups. Fetching the small matching set lets us
    // count individual pending array entries without an expensive collection
    // aggregation on every outgoing notification.
    SharedChain.find({
      $or: [
        { 'pendingInvitations.user': recipientId },
        { owner: recipientId },
      ],
    }).select('owner pendingInvitations pendingJoinRequests').lean(),
  ]);

  const sharedChainItems = sharedChains.reduce((total, chain) => {
    const directInvitations = (chain.pendingInvitations || []).filter((invitation) => (
      sameUserId(invitation.user, recipientId)
      && !invitation.awaitingOwnerApproval
      && !invitation.awaitingFriendship
    )).length;

    if (!sameUserId(chain.owner, recipientId)) return total + directInvitations;

    const invitationReviews = (chain.pendingInvitations || [])
      .filter((invitation) => invitation.awaitingOwnerApproval).length;
    const joinRequests = (chain.pendingJoinRequests || []).length;
    return total + directInvitations + invitationReviews + joinRequests;
  }, 0);

  return unreadMessages + pendingRequests + sharedChainItems;
}

async function sendPushNotification({ recipientId, title, body, data, logLabel, category, badge }) {
  try {
    const recipient = await User.findById(recipientId).select('+expoPushTokens +notificationPreferences');
    const preferences = getNotificationPreferences(recipient);
    if (!preferences.pushEnabled || !preferences[category]) return;

    const tokens = [...new Map((recipient?.expoPushTokens || [])
      .filter((entry) => isExpoPushToken(entry.token))
      .map((entry) => [entry.token, { token: entry.token, platform: entry.platform }])).values()];
    if (!tokens.length) return;

    let badgeCount = typeof badge === 'number' ? badge : 1;
    if (typeof badge !== 'number') {
      try {
        // The persisted notification action was created before this call, so a
        // positive badge is expected. Keep delivering the alert if a transient
        // database failure prevents an exact count.
        badgeCount = Math.max(1, await getRecipientBadgeCount(recipientId));
      } catch (error) {
        console.warn(`Could not calculate ${logLabel} badge count: ${error.message}`);
      }
    }

    const payload = tokens.map(({ token, platform }) => ({
      to: token,
      title,
      body,
      // Android 8+ applies sound and vibration at the channel level. iOS uses its
      // system sound because the bundled MP3 is not a reliable APNs custom sound.
      sound: platform === 'ios' && preferences.sound ? 'default' : undefined,
      channelId: platform === 'android' ? androidMessageChannelId(preferences) : undefined,
      priority: 'high',
      // Send zero rather than omitting the field when badges are disabled, so
      // APNs clears a number that was displayed before this preference changed.
      badge: platform === 'ios' ? (preferences.badges ? badgeCount : 0) : undefined,
      interruptionLevel: platform === 'ios' ? 'active' : undefined,
      data,
    }));
    const result = await postToExpo(EXPO_PUSH_URL, payload);
    const tickets = Array.isArray(result?.data) ? result.data : result?.data ? [result.data] : [];
    const invalidTokens = [];
    const receiptTokens = new Map();
    tickets.forEach((ticket, index) => {
      const token = tokens[index]?.token;
      if (!token) return;
      if (ticket?.status === 'ok' && ticket.id) {
        receiptTokens.set(ticket.id, token);
        return;
      }
      if (ticket?.status === 'error') {
        const errorCode = ticket.details?.error || 'UnknownError';
        console.warn(`Expo ${logLabel} push ticket failed (${errorCode}): ${ticket.message || 'Không rõ lỗi'}`);
        if (errorCode === 'DeviceNotRegistered') invalidTokens.push(token);
      }
    });
    await removeInvalidTokens(recipientId, invalidTokens);
    if (receiptTokens.size) {
      scheduleReceiptCheck({ recipientId, receiptTokens, logLabel });
    }
  } catch (error) {
    // Push delivery is best-effort and must never block a persisted app action.
    console.warn(`Could not send ${logLabel} push notification: ${error.message}`);
  }
}

export function sendChatPushNotification({ recipientId, sender, message }) {
  const friendId = sender.id || sender._id?.toString() || '';
  return sendPushNotification({
    recipientId,
    title: sender.fullName,
    body: previewFor(message),
    logLabel: 'chat',
    category: 'messages',
    data: {
      type: 'chat_message',
      friendId,
      url: `/chat?friendId=${encodeURIComponent(friendId)}`,
    },
  });
}

export function sendFriendRequestPushNotification({ recipientId, sender, requestId }) {
  const routeKey = requestId || `friend-${Date.now()}`;
  return sendPushNotification({
    recipientId,
    title: 'Lời mời kết bạn',
    body: `${sender.fullName || sender.username || 'Một người dùng'} đã gửi lời mời kết bạn cho bạn.`,
    logLabel: 'friend request',
    category: 'friendRequests',
    data: {
      type: 'friend_request',
      requestId,
      url: `/friends-posts?openNotifications=${encodeURIComponent(routeKey)}`,
    },
  });
}

export function sendSharedChainInvitationPushNotification({ recipientId, sender, chainId, chainTitle }) {
  const routeKey = chainId || `shared-chain-${Date.now()}`;
  const groupName = typeof chainTitle === 'string' && chainTitle.trim() ? ` “${chainTitle.trim()}”` : '';
  const senderName = sender?.fullName || sender?.username;
  return sendPushNotification({
    recipientId,
    title: 'Lời mời vào nhóm',
    body: senderName
      ? `${senderName} đã mời bạn tham gia nhóm${groupName}.`
      : `Bạn có một lời mời tham gia nhóm${groupName}.`,
    logLabel: 'shared chain invitation',
    category: 'groupActivity',
    data: {
      type: 'shared_chain_invitation',
      chainId,
      url: `/friends-posts?openNotifications=${encodeURIComponent(routeKey)}`,
    },
  });
}

export function sendSharedChainJoinRequestPushNotification({ recipientId, sender, chainId, chainTitle }) {
  const senderName = sender?.fullName || sender?.username || 'Một người dùng';
  const groupName = typeof chainTitle === 'string' && chainTitle.trim() ? ` “${chainTitle.trim()}”` : '';
  return sendPushNotification({
    recipientId,
    title: 'Yêu cầu tham gia nhóm',
    body: `${senderName} muốn tham gia nhóm${groupName}.`,
    logLabel: 'shared chain join request',
    category: 'groupActivity',
    data: {
      type: 'shared_chain_join_request',
      chainId,
      url: '/shared-streak',
    },
  });
}

export function sendSharedChainInvitationReviewPushNotification({ recipientId, sender, chainId, chainTitle }) {
  const senderName = sender?.fullName || sender?.username || 'Một thành viên';
  const groupName = typeof chainTitle === 'string' && chainTitle.trim() ? ` “${chainTitle.trim()}”` : '';
  return sendPushNotification({
    recipientId,
    title: 'Đề xuất mời thành viên',
    body: `${senderName} có đề xuất mời thành viên mới vào nhóm${groupName}.`,
    logLabel: 'shared chain invitation review',
    category: 'groupActivity',
    data: {
      type: 'shared_chain_invitation_review',
      chainId,
      url: '/shared-streak',
    },
  });
}
