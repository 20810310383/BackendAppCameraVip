import { User } from '../models/User.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_PUSH_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const EXPO_PUSH_TOKEN = /^(?:ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/;
const PUSH_REQUEST_TIMEOUT_MS = 12_000;
const PUSH_RETRY_DELAYS_MS = [500, 1_500];
const PUSH_RECEIPT_DELAYS_MS = [15_000, 60_000, 5 * 60_000];

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
    'Accept-encoding': 'gzip, deflate',
    'Content-Type': 'application/json',
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
      const response = await fetch(url, {
        method: 'POST',
        headers: expoHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(PUSH_REQUEST_TIMEOUT_MS),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) return body;
      const message = body?.errors?.[0]?.message || response.statusText || `HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (error?.status && error.status !== 429 && error.status < 500) throw error;
    }
    const retryDelay = PUSH_RETRY_DELAYS_MS[attempt];
    if (retryDelay !== undefined) await wait(retryDelay);
  }
  throw lastError || new Error('Expo Push Service không phản hồi.');
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

async function sendPushNotification({ recipientId, title, body, data, logLabel }) {
  try {
    const recipient = await User.findById(recipientId).select('+expoPushTokens');
    const tokens = [...new Map((recipient?.expoPushTokens || [])
      .filter((entry) => isExpoPushToken(entry.token))
      .map((entry) => [entry.token, { token: entry.token, platform: entry.platform }])).values()];
    if (!tokens.length) return;

    const payload = tokens.map(({ token, platform }) => ({
      to: token,
      title,
      body,
      // Android can use the packaged MP3. iOS uses its system sound because MP3 is not
      // a reliable APNs custom-sound format; use a WAV asset when a shared custom iOS sound is needed.
      sound: platform === 'android' ? 'amthanhtinnhan.mp3' : 'default',
      channelId: 'messages',
      priority: 'high',
      badge: platform === 'ios' ? 1 : undefined,
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
    data: {
      type: 'shared_chain_invitation_review',
      chainId,
      url: '/shared-streak',
    },
  });
}
