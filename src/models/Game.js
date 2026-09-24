import mongoose from 'mongoose';

const playerSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    displayName: { type: String, required: true, maxlength: 32 },
    side: { type: String, enum: ['w', 'b'], required: true },
    socketId: { type: String, default: null },
  },
  { _id: false },
);

const moveSchema = new mongoose.Schema(
  {
    from: String,
    to: String,
    san: String,
    captured: String,
    promotion: String,
    by: String,
    playedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const gameSchema = new mongoose.Schema(
  {
    roomCode: { type: String, required: true, unique: true, index: true },
    gameType: { type: String, enum: ['chess', 'gomoku', 'checkers'], required: true },
    status: { type: String, enum: ['waiting', 'active', 'finished'], default: 'waiting' },
    players: { type: [playerSchema], default: [] },
    state: {
      fen: { type: String, required: true },
      timeControl: { type: String, default: '10+0' },
    },
    moves: { type: [moveSchema], default: [] },
    winner: { type: String, default: null },
  },
  { timestamps: true },
);

export const Game = mongoose.model('Game', gameSchema);
