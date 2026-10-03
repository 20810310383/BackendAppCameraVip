import { User } from '../models/User.js';

const MAX_LOCATION_TRAIL_POINTS = 60;
const MAX_LOCATION_RECIPIENTS = 100;

function idOf(value) {
  return value?._id?.toString?.() || value?.id?.toString?.() || value?.toString?.() || '';
}

export function locationSharingRecipientIds(user) {
  return [...new Set((user.locationSharingRecipientIds || []).map(idOf).filter(Boolean))];
}

function validRecipientIds(value) {
  if (!Array.isArray(value)) {
    const error = new Error('Danh sách người nhận không hợp lệ.');
    error.code = 'INVALID_LOCATION_RECIPIENTS';
    throw error;
  }
  const recipientIds = [...new Set(value.filter((id) => typeof id === 'string').map((id) => id.trim()))];
  if (recipientIds.length > MAX_LOCATION_RECIPIENTS || recipientIds.some((id) => !/^[a-f\d]{24}$/i.test(id))) {
    const error = new Error('Danh sách người nhận không hợp lệ.');
    error.code = 'INVALID_LOCATION_RECIPIENTS';
    throw error;
  }
  return recipientIds;
}

function optionalBoundedNumber(value, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(maximum, Math.max(minimum, value));
}

export function validateSharedLocation(value) {
  const latitude = value?.latitude;
  const longitude = value?.longitude;
  if (typeof latitude !== 'number' || typeof longitude !== 'number'
    || !Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    const error = new Error('Tọa độ không hợp lệ.');
    error.code = 'INVALID_LOCATION';
    throw error;
  }
  return {
    latitude,
    longitude,
    heading: optionalBoundedNumber(value.heading, 0, 359.999),
    accuracy: optionalBoundedNumber(value.accuracy, 0, 10_000),
    speedKmh: optionalBoundedNumber(value.speedKmh, 0, 500),
    updatedAt: new Date(),
  };
}

function coordinateFrom(point) {
  return { latitude: point.latitude, longitude: point.longitude };
}

export function toLiveLocationPayload(user) {
  if (!user.sharedLocation) return null;
  return {
    userId: user._id.toString(),
    fullName: user.fullName,
    username: user.username,
    avatarPath: user.avatarPath || undefined,
    latitude: user.sharedLocation.latitude,
    longitude: user.sharedLocation.longitude,
    heading: user.sharedLocation.heading ?? null,
    accuracy: user.sharedLocation.accuracy ?? null,
    speedKmh: user.sharedLocation.speedKmh ?? null,
    updatedAt: user.sharedLocation.updatedAt.toISOString(),
    trail: (user.locationTrail || []).map(coordinateFrom),
  };
}

export function emitLocationToRecipients(user, emitSocialEvent, event, payload, recipientIds = locationSharingRecipientIds(user)) {
  const friendIds = new Set((user.friends || []).map(idOf).filter(Boolean));
  for (const recipientId of recipientIds) {
    if (friendIds.has(recipientId)) emitSocialEvent(recipientId, event, payload);
  }
}

export async function updateSharedLocation(user, rawLocation) {
  if (!user.locationSharingEnabled) {
    const error = new Error('Người dùng chưa bật chia sẻ vị trí.');
    error.code = 'LOCATION_SHARING_DISABLED';
    throw error;
  }

  if (!locationSharingRecipientIds(user).length) return null;

  const location = validateSharedLocation(rawLocation);
  user.sharedLocation = location;
  user.locationTrail.push(location);
  if (user.locationTrail.length > MAX_LOCATION_TRAIL_POINTS) {
    user.locationTrail = user.locationTrail.slice(-MAX_LOCATION_TRAIL_POINTS);
  }
  await user.save();
  return toLiveLocationPayload(user);
}

export async function setLocationSharing(user, enabled) {
  user.locationSharingEnabled = enabled;
  user.locationSharingHasBeenConfigured = true;
  if (!enabled) {
    user.sharedLocation = null;
    user.locationTrail = [];
  }
  await user.save();
  return toLiveLocationPayload(user);
}

export async function setLocationSharingRecipients(user, rawRecipientIds) {
  const recipientIds = validRecipientIds(rawRecipientIds);
  const friendIds = new Set((user.friends || []).map(idOf).filter(Boolean));
  if (recipientIds.some((recipientId) => !friendIds.has(recipientId))) {
    const error = new Error('Bạn chỉ có thể chia sẻ vị trí với bạn bè hiện tại.');
    error.code = 'LOCATION_RECIPIENT_NOT_FRIEND';
    throw error;
  }

  user.locationSharingRecipientIds = recipientIds;
  if (!recipientIds.length) {
    user.sharedLocation = null;
    user.locationTrail = [];
  }
  await user.save();
  return recipientIds;
}

export async function getFriendLocationSnapshot(viewerId) {
  const viewer = await User.findById(viewerId).select('friends');
  if (!viewer?.friends?.length) return [];

  // A user-controlled share stays visible until its owner turns it off. The client
  // shows the exact update age, while the background task keeps moving users fresh.
  const friends = await User.find({
    _id: { $in: viewer.friends },
    locationSharingEnabled: true,
    locationSharingRecipientIds: viewer._id,
  }).select('fullName username avatarPath sharedLocation locationTrail');
  return friends.map(toLiveLocationPayload).filter(Boolean);
}
