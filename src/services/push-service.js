import { User } from '../models/User.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_PUSH_TOKEN = /^(?:ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/;

function previewFor(message) {
  if (message.type === 'image') return 'Đã gửi một ảnh 📷';
  if (message.type === 'audio') return 'Đã gửi một tin nhắn thoại 🎙️';
  if (message.type === 'emoji') return message.text || 'Đã gửi một biểu tượng cảm xúc';
  return message.text || 'Bạn có một tin nhắn mới';
}

export function isExpoPushToken(value) {
  return typeof value === 'string' && EXPO_PUSH_TOKEN.test(value);
}

async function sendPushNotification({ recipientId, title, body, data, logLabel }) {
  try {
    const recipient = await User.findById(recipientId).select('+expoPushTokens');
    const tokens = (recipient?.expoPushTokens || [])
      .filter((entry) => isExpoPushToken(entry.token))
      .map((entry) => ({ token: entry.token, platform: entry.platform }));
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
      data,
    }));
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Accept-encoding': 'gzip, deflate', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.warn(`Expo push delivery failed: ${body?.errors?.[0]?.message || response.statusText}`);
      return;
    }

    const invalidTokens = (body?.data || [])
      .map((ticket, index) => ticket?.details?.error === 'DeviceNotRegistered' ? tokens[index]?.token : null)
      .filter(Boolean);
    if (invalidTokens.length) {
      await User.updateOne({ _id: recipientId }, { $pull: { expoPushTokens: { token: { $in: invalidTokens } } } });
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
