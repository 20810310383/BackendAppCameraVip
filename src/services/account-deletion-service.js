import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConversationAppearance } from '../models/ConversationAppearance.js';
import { FriendRequest } from '../models/FriendRequest.js';
import { Message } from '../models/Message.js';
import { MomentPost } from '../models/MomentPost.js';
import { PasswordReset } from '../models/PasswordReset.js';
import { Session } from '../models/Session.js';
import { SharedChain } from '../models/SharedChain.js';
import { User } from '../models/User.js';
import { deleteStoredObjects } from './object-storage-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDirectory = path.resolve(__dirname, '../../uploads');

function uniquePaths(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value))];
}

async function removeStoredPaths(paths) {
  const values = uniquePaths(paths);
  if (!values.length) return;

  const removedR2Paths = await deleteStoredObjects(values);
  await Promise.all(values.map(async (value) => {
    if (removedR2Paths.has(value) || !value.startsWith('/uploads/')) return;
    const relativePath = value.slice('/uploads/'.length);
    const targetPath = path.resolve(uploadsDirectory, relativePath);
    if (!targetPath.startsWith(`${uploadsDirectory}${path.sep}`)) return;
    await unlink(targetPath).catch(() => undefined);
  }));
}

function accountMediaPaths({ user, posts, messages, appearances, ownedChains }) {
  return uniquePaths([
    user.avatarPath,
    user.coverPath,
    ...posts.flatMap((post) => [post.media?.path, post.media?.thumbnailPath]),
    ...messages.flatMap((message) => [message.attachment?.path, message.momentReply?.media?.path]),
    ...appearances.map((appearance) => appearance.wallpaper?.path),
    ...ownedChains.map((chain) => chain.avatarPath),
  ]);
}

/**
 * Permanently removes a user's account and all first-party records that rely
 * on it. This deliberately performs no soft delete or support-email approval
 * step: App Store account-deletion requests must finish in the app.
 */
export async function deleteUserAccount({ user, emitSocialEvent = () => undefined }) {
  const userId = user._id;
  const friendIds = (user.friends || []).map((friendId) => friendId.toString());

  const [posts, messages, appearances, ownedChains] = await Promise.all([
    MomentPost.find({ author: userId }).select('media.path media.thumbnailPath').lean(),
    Message.find({ participants: userId }).select('conversationKey attachment.path momentReply.media.path').lean(),
    ConversationAppearance.find({ participants: userId }).select('wallpaper.path').lean(),
    SharedChain.find({ owner: userId }).select('avatarPath').lean(),
  ]);
  const ownedChainIds = ownedChains.map((chain) => chain._id);

  // Remove files first. If managed object storage is unavailable, preserve the
  // account so the user can retry instead of leaving retained media behind.
  await removeStoredPaths(accountMediaPaths({ user, posts, messages, appearances, ownedChains }));

  await Promise.all([
    Session.deleteMany({ userId }),
    PasswordReset.deleteMany({ userId }),
    FriendRequest.deleteMany({ $or: [{ from: userId }, { to: userId }] }),
    Message.deleteMany({ participants: userId }),
    ConversationAppearance.deleteMany({ participants: userId }),
    MomentPost.deleteMany({ author: userId }),
    SharedChain.deleteMany({ owner: userId }),
    User.updateMany(
      { _id: { $ne: userId } },
      {
        $pull: {
          friends: userId,
          following: userId,
          followers: userId,
          blockedUsers: userId,
          locationSharingRecipientIds: userId,
        },
      },
    ),
    MomentPost.updateMany(
      { author: { $ne: userId } },
      {
        $pull: {
          recipientIds: userId,
          views: { user: userId },
          ...(ownedChainIds.length
            ? {
                sharedChainIds: { $in: ownedChainIds },
                sharedChainExcludedIds: { $in: ownedChainIds },
              }
            : {}),
        },
      },
    ),
    SharedChain.updateMany(
      { owner: { $ne: userId } },
      {
        $pull: {
          members: { user: userId },
          pendingInvitations: { $or: [{ user: userId }, { invitedBy: userId }] },
          pendingJoinRequests: { user: userId },
        },
      },
    ),
  ]);

  await User.deleteOne({ _id: userId });

  for (const friendId of friendIds) {
    emitSocialEvent(friendId, 'social:friend-removed', { userId: userId.toString() });
    emitSocialEvent(friendId, 'social:friends-updated', { reason: 'account_deleted' });
  }

  return {
    deletedPostCount: posts.length,
    deletedConversationCount: new Set(messages.map((message) => message.conversationKey).filter(Boolean)).size,
  };
}
