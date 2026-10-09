import mongoose from 'mongoose';

// One document per user per calendar day. `date` is the device's LOCAL calendar
// day as "YYYY-MM-DD", not a Date: the day a walk belongs to is the day the
// walker's own clock said it was, so travelling across timezones must not
// re-file or split a day's steps.
const stepDailySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    date: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    // Cumulative step total for the day, straight off the hardware step counter.
    steps: {
      type: Number,
      required: true,
      min: 0,
      max: 300000,
    },
    // Derived from `steps` and an estimated stride length, so it is an estimate
    // and is labelled as one in the UI. `steps` is the only measured value.
    distanceMeters: {
      type: Number,
      default: null,
      min: 0,
      max: 400000,
    },
    activeMinutes: {
      type: Number,
      default: null,
      min: 0,
      max: 1440,
    },
    firstStepAt: {
      type: Date,
      default: null,
    },
    lastStepAt: {
      type: Date,
      default: null,
    },
    // Which sensor produced the reading, e.g. ["pedometer:android"].
    sources: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true },
);

stepDailySchema.index({ userId: 1, date: 1 }, { unique: true });
stepDailySchema.index({ userId: 1, date: -1 });

stepDailySchema.set('toJSON', {
  transform: (_document, returnedObject) => {
    delete returnedObject._id;
    delete returnedObject.__v;
    delete returnedObject.userId;
    return returnedObject;
  },
});

export const StepDaily = mongoose.models.StepDaily || mongoose.model('StepDaily', stepDailySchema);
