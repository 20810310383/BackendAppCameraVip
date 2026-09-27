import mongoose from 'mongoose';
import { User } from '../models/User.js';

export function conversationKeyFor(firstUserId, secondUserId) {
  return [firstUserId.toString(), secondUserId.toString()].sort().join(':');
}

export function areUsersConnected(firstUser, secondUser) {
  if (!firstUser || !secondUser || firstUser._id.equals(secondUser._id)) return false;
  const areFriends = (firstUser.friends || []).some((friendId) => friendId.equals(secondUser._id));
  const isBlocked = (firstUser.blockedUsers || []).some((userId) => userId.equals(secondUser._id))
    || (secondUser.blockedUsers || []).some((userId) => userId.equals(firstUser._id));
  return areFriends && !isBlocked;
}

export async function canUsersMessage(firstUserId, secondUserId) {
  if (!mongoose.isValidObjectId(firstUserId) || !mongoose.isValidObjectId(secondUserId)) return false;
  const [firstUser, secondUser] = await Promise.all([
    User.findById(firstUserId).select('friends blockedUsers'),
    User.findById(secondUserId).select('friends blockedUsers'),
  ]);
  return areUsersConnected(firstUser, secondUser);
}

