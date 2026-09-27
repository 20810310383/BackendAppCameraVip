import mongoose from 'mongoose';

const wallpaperSchema = new mongoose.Schema(
  {
    path: { type: String, trim: true, required: true },
    mimeType: { type: String, trim: true, default: 'image/webp' },
    filename: { type: String, trim: true, required: true },
    width: { type: Number, min: 0 },
    height: { type: Number, min: 0 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { _id: false, timestamps: true },
);

const conversationAppearanceSchema = new mongoose.Schema(
  {
    conversationKey: { type: String, required: true, unique: true, index: true },
    participants: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
      validate: [(value) => Array.isArray(value) && value.length === 2, 'A direct conversation needs two participants.'],
    },
    wallpaper: { type: wallpaperSchema, default: null },
  },
  { timestamps: true },
);

export const ConversationAppearance = mongoose.models.ConversationAppearance
  || mongoose.model('ConversationAppearance', conversationAppearanceSchema);
