import mongoose from 'mongoose';

const mediaSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['image', 'video'], required: true },
    path: { type: String, trim: true, required: true },
    mimeType: { type: String, trim: true, required: true },
    filename: { type: String, trim: true, required: true },
    thumbnailPath: { type: String, trim: true, default: '' },
    width: { type: Number, min: 0 },
    height: { type: Number, min: 0 },
    durationMs: { type: Number, min: 0 },
  },
  { _id: false },
);

const stickerSchema = new mongoose.Schema(
  {
    emoji: { type: String, trim: true, maxlength: 24, required: true },
    x: { type: Number, min: -4_000, max: 4_000 },
    y: { type: Number, min: -4_000, max: 4_000 },
    scale: { type: Number, min: 0.25, max: 4 },
    rotation: { type: Number, min: -360, max: 360 },
  },
  { _id: false },
);

const postViewSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    viewedAt: { type: Date, default: Date.now, required: true },
  },
  { _id: false },
);

const widgetSchema = new mongoose.Schema(
  {
    badge: { type: String, trim: true, maxlength: 40 },
    title: { type: String, trim: true, maxlength: 220 },
    subtitle: { type: String, trim: true, maxlength: 160 },
    type: { type: String, trim: true, maxlength: 32 },
    icon: { type: String, trim: true, maxlength: 48 },
    color: { type: String, trim: true, maxlength: 32 },
    bgTint: { type: String, trim: true, maxlength: 48 },
    borderColor: { type: String, trim: true, maxlength: 48 },
    fontStyleId: { type: String, trim: true, maxlength: 32 },
    fontColor: { type: String, trim: true, maxlength: 24 },
    glowEffectId: { type: String, trim: true, maxlength: 32 },
    music: {
      title: { type: String, trim: true, maxlength: 160 },
      artist: { type: String, trim: true, maxlength: 160 },
      coverUrl: { type: String, trim: true, maxlength: 1_200 },
      previewUrl: { type: String, trim: true, maxlength: 1_200 },
      coverColors: [{ type: String, trim: true, maxlength: 24 }],
    },
  },
  { _id: false },
);

const imageEditSchema = new mongoose.Schema(
  {
    filterId: { type: String, trim: true, maxlength: 32, default: 'original' },
    filterIntensity: { type: Number, min: 0, max: 100, default: 100 },
    brightnessLevel: { type: Number, min: -50, max: 50, default: 0 },
    contrastLevel: { type: Number, min: -50, max: 50, default: 0 },
    warmthLevel: { type: Number, min: -50, max: 50, default: 0 },
    saturationLevel: { type: Number, min: -50, max: 50, default: 0 },
    vignetteLevel: { type: Number, min: 0, max: 100, default: 0 },
    grainLevel: { type: Number, min: 0, max: 100, default: 0 },
    smoothLevel: { type: Number, min: 0, max: 100, default: 0 },
    sparkleFXEnabled: { type: Boolean, default: false },
  },
  { _id: false },
);

const momentPostSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    media: { type: mediaSchema, required: true },
    caption: { type: String, trim: true, maxlength: 500, default: '' },
    stickers: { type: [stickerSchema], default: [] },
    widget: { type: widgetSchema, default: null },
    imageEdit: { type: imageEditSchema, default: null },
    // `all` keeps legacy posts visible to every current friend. A `selected` post
    // is only visible to the friend ids captured when it was published.
    shareMode: { type: String, enum: ['all', 'selected'], default: 'all', index: true },
    recipientIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },
    views: { type: [postViewSchema], default: [] },
  },
  { timestamps: true },
);

momentPostSchema.index({ createdAt: -1, author: 1 });

export const MomentPost = mongoose.models.MomentPost
  || mongoose.model('MomentPost', momentPostSchema);
