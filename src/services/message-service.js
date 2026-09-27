import mongoose from 'mongoose';
import { User } from '../models/User.js';

export function conversationKeyFor(firstUserId, secondUserId) {
  return [firstUserId.toString(), secondUserId.toString()].sort().join(':');
}

function userHasId(user, field, targetUserId) {
  return (user?.[field] || []).some((userId) => userId.equals(targetUserId));
}

export function messageAccessStatus(firstUser, secondUser) {
  if (!firstUser || !secondUser || firstUser._id.equals(secondUser._id)) return 'friend_required';

  const isBlocked = userHasId(firstUser, 'blockedUsers', secondUser._id)
    || userHasId(secondUser, 'blockedUsers', firstUser._id);
  if (isBlocked) return 'blocked';

  const areFriends = userHasId(firstUser, 'friends', secondUser._id)
    && userHasId(secondUser, 'friends', firstUser._id);
  return areFriends ? 'available' : 'friend_required';
}

export function areUsersConnected(firstUser, secondUser) {
  return messageAccessStatus(firstUser, secondUser) === 'available';
}

export async function canUsersMessage(firstUserId, secondUserId) {
  if (!mongoose.isValidObjectId(firstUserId) || !mongoose.isValidObjectId(secondUserId)) return false;
  const [firstUser, secondUser] = await Promise.all([
    User.findById(firstUserId).select('friends blockedUsers'),
    User.findById(secondUserId).select('friends blockedUsers'),
  ]);
  return areUsersConnected(firstUser, secondUser);
}
