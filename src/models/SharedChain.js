import mongoose from 'mongoose';

const memberSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    joinedAt: { type: Date, default: Date.now, required: true },
  },
  { _id: false },
);

const invitationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, default: Date.now, required: true },
    // Invitations proposed by a member must be reviewed by the group owner
    // before the recipient sees and can accept the invitation.
    awaitingOwnerApproval: { type: Boolean, default: false },
    isFriendOfOwner: { type: Boolean, default: true },
    // When the recipient is not yet a friend of the owner, the owner sends a
    // friend request first. The group invitation is only released after that
    // friend request is accepted.
    awaitingFriendship: { type: Boolean, default: false },
    friendRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'FriendRequest', default: null },
  },
  { _id: false },
);

const joinRequestSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    requestedAt: { type: Date, default: Date.now, required: true },
  },
  { _id: false },
);

const sharedChainSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, maxlength: 80, default: 'Chuỗi chung' },
    avatarPath: { type: String, trim: true, default: '' },
    // This intentionally is not unique: one account can own up to 12 groups.
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    inviteCode: { type: String, trim: true, uppercase: true, unique: true, sparse: true, index: true },
    members: { type: [memberSchema], default: [] },
    pendingInvitations: { type: [invitationSchema], default: [] },
    pendingJoinRequests: { type: [joinRequestSchema], default: [] },
  },
  { timestamps: true },
);

sharedChainSchema.index({ 'members.user': 1, updatedAt: -1 });
sharedChainSchema.index({ 'pendingInvitations.user': 1, updatedAt: -1 });
sharedChainSchema.index({ 'pendingJoinRequests.user': 1, updatedAt: -1 });

export const SharedChain = mongoose.models.SharedChain
  || mongoose.model('SharedChain', sharedChainSchema);

// Existing installations used a unique `owner_1` index. Mongoose does not
// remove an old database index when `unique` is removed from the schema, so
// explicitly retire it once before ensuring the new indexes.
export async function migrateSharedChainIndexes() {
  const indexes = await SharedChain.collection.indexes().catch((error) => {
    // A fresh database has no collection yet; createIndexes below will create it.
    if (error?.code === 26) return [];
    throw error;
  });
  const legacyOwnerIndex = indexes.find((index) => index.name === 'owner_1' && index.unique);
  if (legacyOwnerIndex) await SharedChain.collection.dropIndex(legacyOwnerIndex.name);
  await SharedChain.createIndexes();
}
