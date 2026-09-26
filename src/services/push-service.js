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

export async function sendChatPushNotification({ recipientId, sender, message }) {
  try {
    const recipient = await User.findById(recipientId).select('+expoPushTokens');
    const tokens = (recipient?.expoPushTokens || [])
      .filter((entry) => isExpoPushToken(entry.token))
      .map((entry) => ({ token: entry.token, platform: entry.platform }));
    if (!tokens.length) return;

    const payload = tokens.map(({ token, platform }) => ({
      to: token,
      title: sender.fullName,
      body: previewFor(message),
      // Android can use the packaged MP3. iOS uses its system sound because MP3 is not
      // a reliable APNs custom-sound format; use a WAV asset when a shared custom iOS sound is needed.
      sound: platform === 'android' ? 'amthanhtinnhan.mp3' : 'default',
      channelId: 'messages',
      priority: 'high',
      data: {
        type: 'chat_message',
        friendId: sender.id || sender._id?.toString(),
      },
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
    // Push delivery is best-effort and must never block a persisted realtime message.
    console.warn(`Could not send chat push notification: ${error.message}`);
  }
}
