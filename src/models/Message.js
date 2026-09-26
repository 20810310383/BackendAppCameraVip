import mongoose from 'mongoose';

const attachmentSchema = new mongoose.Schema(
  {
    path: { type: String, trim: true, default: '' },
    mimeType: { type: String, trim: true, default: '' },
    filename: { type: String, trim: true, default: '' },
    width: { type: Number, min: 0 },
    height: { type: Number, min: 0 },
    durationMs: { type: Number, min: 0 },
  },
  { _id: false },
);

const messageSchema = new mongoose.Schema(
  {
    conversationKey: { type: String, required: true, index: true },
    participants: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
      validate: [(value) => Array.isArray(value) && value.length === 2, 'A direct conversation needs two participants.'],
      index: true,
    },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['text', 'emoji', 'image', 'audio'], required: true, default: 'text' },
    text: { type: String, trim: true, maxlength: 2000, default: '' },
    attachment: { type: attachmentSchema, default: undefined },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    deletedFor: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: [],
      index: true,
    },
  },
  { timestamps: true },
);

messageSchema.index({ conversationKey: 1, createdAt: -1 });
messageSchema.index({ recipient: 1, readAt: 1, createdAt: -1 });

export const Message = mongoose.models.Message || mongoose.model('Message', messageSchema);
