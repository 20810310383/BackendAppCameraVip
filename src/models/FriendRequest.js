import mongoose from 'mongoose';

const friendRequestSchema = new mongoose.Schema(
  {
    from: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    to: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    pairKey: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: ['pending'],
      default: 'pending',
      required: true,
    },
  },
  { timestamps: true },
);

friendRequestSchema.index({ to: 1, createdAt: -1 });
friendRequestSchema.index({ from: 1, createdAt: -1 });

export const FriendRequest = mongoose.models.FriendRequest || mongoose.model('FriendRequest', friendRequestSchema);


