import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    accessTokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
      select: false,
    },
    refreshTokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
      select: false,
    },
    accessTokenExpiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    lastUsedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    userAgent: {
      type: String,
      default: '',
      maxlength: 500,
    },
    ipAddress: {
      type: String,
      default: '',
      maxlength: 100,
    },
  },
  { timestamps: true },
);

export const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);
