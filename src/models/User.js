import mongoose from 'mongoose';

const sharedLocationSchema = new mongoose.Schema(
  {
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    heading: { type: Number, default: null },
    accuracy: { type: Number, default: null },
    updatedAt: { type: Date, required: true },
  },
  { _id: false },
);

const userSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 80,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9_]{3,24}$/,
    },
    bio: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    avatarPath: {
      type: String,
      trim: true,
      default: '',
    },
    coverPath: {
      type: String,
      trim: true,
      default: '',
    },
    friends: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: [],
    },
    following: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: [],
    },
    followers: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: [],
    },
    blockedUsers: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: [],
    },
    // Location is only exposed through the dedicated, recipient-restricted map endpoints.
    locationSharingEnabled: {
      type: Boolean,
      default: false,
      index: true,
    },
    locationSharingHasBeenConfigured: {
      type: Boolean,
      default: false,
    },
    locationSharingRecipientIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: [],
    },
    sharedLocation: {
      type: sharedLocationSchema,
      default: null,
    },
    locationTrail: {
      type: [sharedLocationSchema],
      default: [],
    },
    lastActiveAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    expoPushTokens: {
      type: [{
        token: { type: String, required: true, trim: true },
        platform: { type: String, enum: ['android', 'ios'], required: true },
        updatedAt: { type: Date, default: Date.now },
      }],
      default: [],
      select: false,
    },
    googleSubject: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      immutable: true,
    },
    passwordHash: {
      type: String,
      select: false,
    },
  },
  { timestamps: true },
);

userSchema.set('toJSON', {
  transform: (_document, returnedObject) => {
    returnedObject.id = returnedObject._id.toString();
    delete returnedObject._id;
    delete returnedObject.__v;
    delete returnedObject.passwordHash;
    delete returnedObject.friends;
    delete returnedObject.following;
    delete returnedObject.followers;
    delete returnedObject.blockedUsers;
    delete returnedObject.expoPushTokens;
    delete returnedObject.googleSubject;
    delete returnedObject.locationSharingEnabled;
    delete returnedObject.locationSharingHasBeenConfigured;
    delete returnedObject.locationSharingRecipientIds;
    delete returnedObject.sharedLocation;
    delete returnedObject.locationTrail;
    return returnedObject;
  },
});

userSchema.index({ locationSharingEnabled: 1, 'sharedLocation.updatedAt': 1 });

export const User = mongoose.models.User || mongoose.model('User', userSchema);
