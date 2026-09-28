import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import mongoose from 'mongoose';
import { Server } from 'socket.io';
import { Game } from './models/Game.js';
import { FriendRequest } from './models/FriendRequest.js';
import { Message } from './models/Message.js';
import { Session } from './models/Session.js';
import { migrateSharedChainIndexes } from './models/SharedChain.js';
import { User } from './models/User.js';
import { createAuthRouter } from './routes/auth.js';
import { createPasswordResetRouter } from './routes/password-reset.js';
import { createProfileRouter, uploadsDirectory } from './routes/profile.js';
import { createSessionRouter } from './routes/session.js';
import { createSocialRouter } from './routes/social.js';
import { createMessageRouter } from './routes/messages.js';
import { createMomentPostRouter } from './routes/posts.js';
import { createSharedChainRouter } from './routes/shared-chain.js';
import { applyChessMove, INITIAL_FEN, sideToMove } from './services/chess-service.js';
import { canUsersMessage } from './services/message-service.js';
import { getStockfishMove, STOCKFISH_SETTINGS, warmStockfish } from './services/stockfish-service.js';
import { verifyEmailTransport } from './services/email-service.js';
import { findAvailableUsername } from './services/username-service.js';
import { hashSessionToken } from './services/session-service.js';

const PORT = Number(process.env.PORT ?? 4000);
const corsOrigin = process.env.CORS_ORIGIN ?? '*';
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: corsOrigin, methods: ['GET', 'POST'] } });
const memoryGames = new Map();
let mongoReady = false;

function socialRoom(userId) {
  return `social:user:${userId.toString()}`;
}

function isUserOnline(userId) {
  return Boolean(io.sockets.adapter.rooms.get(socialRoom(userId))?.size);
}

function emitSocialEvent(userId, event, payload) {
  io.to(socialRoom(userId)).emit(event, payload);
}

async function notifyFriendsOfPresence(userId, isOnline, lastActiveAt) {
  if (!mongoReady) return;
  const user = await User.findById(userId).select('friends');
  for (const friendId of user?.friends || []) {
    emitSocialEvent(friendId, 'social:presence-changed', {
      userId: userId.toString(),
      isOnline,
      lastActiveAt: lastActiveAt.toISOString(),
    });
  }
}

app.use(cors({ origin: corsOrigin }));
app.use(express.json());
app.use('/uploads', express.static(uploadsDirectory, { immutable: true, maxAge: '30d' }));
app.use('/api/auth', createAuthRouter({ isDatabaseReady: () => mongoReady }));
app.use('/api/auth', createSessionRouter({ isDatabaseReady: () => mongoReady }));
app.use('/api/auth', createPasswordResetRouter({ isDatabaseReady: () => mongoReady }));
app.use('/api', createSocialRouter({
  isDatabaseReady: () => mongoReady,
  emitSocialEvent,
  isUserOnline,
}));
app.use('/api', createMessageRouter({
  isDatabaseReady: () => mongoReady,
  isUserOnline,
  emitMessageEvent: emitSocialEvent,
}));
app.use('/api', createMomentPostRouter({
  isDatabaseReady: () => mongoReady,
  isUserOnline,
  emitPostEvent: emitSocialEvent,
}));
app.use('/api', createSharedChainRouter({
  isDatabaseReady: () => mongoReady,
  isUserOnline,
  emitSharedChainEvent: emitSocialEvent,
}));
app.use('/api', createProfileRouter({
  isDatabaseReady: () => mongoReady,
  emitSocialEvent,
  isUserOnline,
}));

async function backfillUsernames() {
  const usersWithoutUsername = await User.find({
    $or: [{ username: { $exists: false } }, { username: null }, { username: '' }],
  }).select('_id email');

  for (const user of usersWithoutUsername) {
    const username = await findAvailableUsername(User, user.email.split('@')[0]);
    await User.updateOne({ _id: user._id }, { $set: { username } });
  }
}

function toPlain(game) {
  return typeof game.toObject === 'function' ? game.toObject() : game;
}

function publicGame(game) {
  const plain = toPlain(game);
  return {
    ...plain,
    players: plain.players.map(({ socketId, ...player }) => player),
  };
}

async function createGame(data) {
  if (mongoReady) return Game.create(data);
  const game = {
    ...data,
    _id: randomBytes(12).toString('hex'),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  memoryGames.set(game.roomCode, game);
  return game;
}

async function findGame(roomCode) {
  if (mongoReady) return Game.findOne({ roomCode });
  return memoryGames.get(roomCode) ?? null;
}

async function saveGame(game) {
  if (mongoReady) return game.save();
  game.updatedAt = new Date();
  memoryGames.set(game.roomCode, game);
  return game;
}

function newRoomCode() {
  return randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
}

async function createUniqueRoomCode() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const roomCode = newRoomCode();
    if (!(await findGame(roomCode))) return roomCode;
  }
  throw new Error('Không tạo được mã phòng. Vui lòng thử lại.');
}

function findPlayer(game, socketId) {
  return game.players.find((player) => player.socketId === socketId || player.userId === socketId);
}

function callbackOrNoop(callback) {
  return typeof callback === 'function' ? callback : () => {};
}

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, service: 'boardverse-backend', database: mongoReady ? 'mongodb' : 'memory' });
});

app.post('/api/chess/bot-move', async (request, response) => {
  try {
    const fen = String(request.body?.fen || '');
    if (!fen) return response.status(400).json({ error: 'Thiếu trạng thái bàn cờ.' });

    const outcome = await getStockfishMove(fen);
    if (!outcome) return response.status(409).json({ error: 'Ván cờ đã kết thúc.' });

    return response.json({ ...outcome, engine: STOCKFISH_SETTINGS });
  } catch (error) {
    const invalidFen = error.message?.includes('Invalid FEN');
    return response.status(invalidFen ? 400 : 503).json({
      error: invalidFen ? 'Trạng thái bàn cờ không hợp lệ.' : 'Stockfish hiện không phản hồi. Hãy thử lại.',
    });
  }
});

app.get('/api/games/:roomCode', async (request, response) => {
  const game = await findGame(request.params.roomCode.toUpperCase());
  if (!game) return response.status(404).json({ error: 'Không tìm thấy phòng.' });
  return response.json({ game: publicGame(game) });
});

io.on('connection', (socket) => {
  socket.on('social:subscribe', async (payload = {}, callback) => {
    const respond = callbackOrNoop(callback);
    if (!mongoReady) return respond({ error: 'Cơ sở dữ liệu đang tạm thời không khả dụng.' });

    const accessToken = typeof payload.accessToken === 'string' ? payload.accessToken.trim() : '';
    if (!accessToken) return respond({ error: 'Phiên đăng nhập không hợp lệ.' });

    try {
      const session = await Session.findOne({
        accessTokenHash: hashSessionToken(accessToken),
        accessTokenExpiresAt: { $gt: new Date() },
      });
      if (!session) return respond({ error: 'Phiên đăng nhập đã hết hạn.' });

      const previousUserId = socket.data.socialUserId;
      if (previousUserId && previousUserId !== session.userId.toString()) socket.leave(socialRoom(previousUserId));

      socket.data.socialUserId = session.userId.toString();
      socket.join(socialRoom(session.userId));
      const lastActiveAt = new Date();
      await User.updateOne({ _id: session.userId }, { $set: { lastActiveAt } });
      await notifyFriendsOfPresence(session.userId, true, lastActiveAt);
      respond({ ok: true });
    } catch (error) {
      console.warn(`Social realtime subscription failed: ${error.message}`);
      respond({ error: 'Không thể kết nối cập nhật thời gian thực.' });
    }
  });

  socket.on('message:typing', async (payload = {}) => {
    try {
      if (!mongoReady || !socket.data.socialUserId) return;
      const recipientId = typeof payload.recipientId === 'string' ? payload.recipientId : '';
      if (!recipientId || !(await canUsersMessage(socket.data.socialUserId, recipientId))) return;
      emitSocialEvent(recipientId, 'message:typing', {
        fromUserId: socket.data.socialUserId,
        isTyping: Boolean(payload.isTyping),
      });
    } catch (error) {
      console.warn(`Message typing update failed: ${error.message}`);
    }
  });

  socket.on('room:create', async (payload = {}, callback) => {
    const respond = callbackOrNoop(callback);
    try {
      const roomCode = await createUniqueRoomCode();
      const game = await createGame({
        roomCode,
        gameType: 'chess',
        status: 'waiting',
        players: [{ userId: socket.id, socketId: socket.id, displayName: payload.displayName || 'Kỳ thủ trắng', side: 'w' }],
        state: { fen: INITIAL_FEN, timeControl: payload.timeControl || '10+0' },
        moves: [],
      });
      socket.join(roomCode);
      respond({ game: publicGame(game), playerSide: 'w' });
    } catch (error) {
      respond({ error: error.message || 'Không tạo được phòng.' });
    }
  });

  socket.on('room:join', async (payload = {}, callback) => {
    const respond = callbackOrNoop(callback);
    try {
      const roomCode = String(payload.roomCode || '').trim().toUpperCase();
      const game = await findGame(roomCode);
      if (!game) return respond({ error: 'Không tìm thấy phòng này.' });
      if (game.gameType !== 'chess') return respond({ error: 'Phòng này không phải cờ vua.' });

      const existingPlayer = findPlayer(game, socket.id);
      if (existingPlayer) {
        existingPlayer.socketId = socket.id;
        await saveGame(game);
        socket.join(roomCode);
        return respond({ game: publicGame(game), playerSide: existingPlayer.side });
      }
      if (game.players.length >= 2) return respond({ error: 'Phòng đã đủ hai người.' });

      const player = { userId: socket.id, socketId: socket.id, displayName: payload.displayName || 'Kỳ thủ đen', side: 'b' };
      game.players.push(player);
      game.status = 'active';
      await saveGame(game);
      socket.join(roomCode);
      const result = { game: publicGame(game), playerSide: 'b' };
      respond(result);
      io.to(roomCode).emit('room:ready', { game: publicGame(game) });
    } catch (error) {
      respond({ error: error.message || 'Không vào được phòng.' });
    }
  });

  socket.on('chess:move', async (payload = {}, callback) => {
    const respond = callbackOrNoop(callback);
    try {
      const game = await findGame(String(payload.roomCode || '').toUpperCase());
      if (!game || game.status !== 'active') return respond({ error: 'Ván đấu chưa sẵn sàng.' });
      const player = findPlayer(game, socket.id);
      if (!player) return respond({ error: 'Bạn không thuộc phòng này.' });
      if (payload.fen !== game.state.fen) return respond({ error: 'Bàn cờ đã thay đổi, hãy thử lại.' });
      if (player.side !== sideToMove(game.state.fen)) return respond({ error: 'Chưa đến lượt của bạn.' });

      const outcome = applyChessMove(game.state.fen, payload);
      game.state.fen = outcome.fen;
      game.moves.push({ ...outcome.move, by: player.userId, playedAt: new Date() });
      if (outcome.isGameOver) {
        game.status = 'finished';
        game.winner = outcome.winner;
      }
      await saveGame(game);
      const event = {
        roomCode: game.roomCode,
        fen: outcome.fen,
        move: outcome.move,
        turn: outcome.turn,
        gameOver: outcome.isGameOver,
        isCheckmate: outcome.isCheckmate,
        isDraw: outcome.isDraw,
        winner: outcome.winner,
        loser: outcome.loser,
        endReason: outcome.endReason,
      };
      io.to(game.roomCode).emit('chess:move-applied', event);
      if (outcome.isGameOver) {
        io.to(game.roomCode).emit('chess:game-over', {
          roomCode: game.roomCode,
          winner: outcome.winner,
          loser: outcome.loser,
          reason: outcome.endReason || 'game_over',
          isDraw: outcome.isDraw,
        });
      }
      respond({ ok: true });
    } catch (error) {
      const message = 'Nước đi không hợp lệ.';
      socket.emit('game:error', { message });
      respond({ error: message });
    }
  });

  socket.on('chess:resign', async (payload = {}, callback) => {
    const respond = callbackOrNoop(callback);
    try {
      const roomCode = String(payload.roomCode || '').toUpperCase();
      const game = await findGame(roomCode);
      if (!game || game.status !== 'active') return respond({ error: 'Ván đấu không còn hoạt động.' });
      const player = findPlayer(game, socket.id);
      if (!player) return respond({ error: 'Bạn không thuộc phòng này.' });

      const winnerSide = player.side === 'w' ? 'b' : 'w';
      game.status = 'finished';
      game.winner = winnerSide;
      await saveGame(game);

      const gameOverEvent = {
        roomCode: game.roomCode,
        winner: winnerSide,
        loser: player.side,
        reason: 'resignation',
        resignedBy: player.displayName || (player.side === 'w' ? 'Quân trắng' : 'Quân đen'),
        isDraw: false,
      };

      io.to(game.roomCode).emit('chess:game-over', gameOverEvent);
      respond({ ok: true, ...gameOverEvent });
    } catch (error) {
      respond({ error: error.message || 'Không thể chịu thua lúc này.' });
    }
  });

  socket.on('chess:restart', async (payload = {}, callback) => {
    const respond = callbackOrNoop(callback);
    try {
      const roomCode = String(payload.roomCode || '').toUpperCase();
      const game = await findGame(roomCode);
      if (!game) return respond({ error: 'Không tìm thấy phòng.' });

      game.state.fen = INITIAL_FEN;
      game.moves = [];
      game.status = 'active';
      game.winner = null;
      await saveGame(game);

      io.to(roomCode).emit('chess:game-restarted', {
        roomCode: game.roomCode,
        fen: INITIAL_FEN,
        status: 'active',
      });
      respond({ ok: true });
    } catch (error) {
      respond({ error: error.message || 'Không thể tạo ván mới.' });
    }
  });

  socket.on('room:leave', async (payload = {}, callback) => {
    const respond = callbackOrNoop(callback);
    try {
      const roomCode = String(payload.roomCode || '').toUpperCase();
      const game = await findGame(roomCode);
      if (game) {
        socket.leave(roomCode);
        const player = findPlayer(game, socket.id);
        game.players = game.players.filter((p) => p.socketId !== socket.id && p.userId !== socket.id);
        if (game.status === 'active') {
          game.status = 'finished';
          const opponent = game.players[0];
          if (opponent) {
            game.winner = opponent.side;
          }
        }
        await saveGame(game);
        io.to(roomCode).emit('room:player-left', {
          roomCode,
          leftSide: player?.side,
          displayName: player?.displayName || (player?.side === 'w' ? 'Quân trắng' : 'Quân đen'),
        });
      }
      respond({ ok: true });
    } catch (error) {
      respond({ error: error.message || 'Lỗi khi rời phòng.' });
    }
  });

  socket.on('disconnect', async () => {
    const socialUserId = socket.data.socialUserId;
    if (socialUserId) {
      setTimeout(() => {
        if (isUserOnline(socialUserId)) return;
        const lastActiveAt = new Date();
        void User.updateOne({ _id: socialUserId }, { $set: { lastActiveAt } })
          .then(() => notifyFriendsOfPresence(socialUserId, false, lastActiveAt))
          .catch((error) => console.warn(`Could not update activity status: ${error.message}`));
      }, 0);
    }
    if (mongoReady) {
      await Game.updateMany({ 'players.socketId': socket.id }, { $set: { 'players.$.socketId': null } });
    }
    for (const [roomCode, game] of memoryGames.entries()) {
      const player = game.players?.find((p) => p.socketId === socket.id);
      if (player) {
        io.to(roomCode).emit('room:player-left', {
          roomCode,
          leftSide: player.side,
          displayName: player.displayName || (player.side === 'w' ? 'Quân trắng' : 'Quân đen'),
        });
      }
    }
  });
});

let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  try {
    io.close();
    if (typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }
    await new Promise((resolve) => httpServer.close(resolve));
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  } catch (err) {
    console.error('Error during shutdown:', err);
  } finally {
    process.exit(0);
  }
}

process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

async function start() {
  if (process.env.MONGODB_URI) {
    try {
      await mongoose.connect(process.env.MONGODB_URI);
      mongoReady = true;
      console.log('MongoDB connected');
      await backfillUsernames().catch((e) => console.warn('Backfill usernames warning:', e.message));
      await Promise.allSettled([
        User.createIndexes(),
        FriendRequest.createIndexes(),
        Message.createIndexes(),
        migrateSharedChainIndexes(),
      ]);
      void verifyEmailTransport()
        .then((ready) => console.log(ready ? 'Email transport is ready' : 'Email transport is not configured'))
        .catch((error) => console.warn(`Email transport unavailable: ${error.message}`));
    } catch (error) {
      console.warn(`MongoDB unavailable, using in-memory games: ${error.message}`);
    }
  } else {
    console.warn('MONGODB_URI is not set, using in-memory games for local demo.');
  }

  let attempts = 0;
  const maxRetries = 10;
  const retryDelay = 600;

  function tryListen() {
    httpServer.listen(PORT, '0.0.0.0');
  }

  httpServer.on('listening', () => {
    console.log(`Boardverse API listening on http://0.0.0.0:${PORT}`);
    void warmStockfish().then(() => console.log('Stockfish is ready')).catch((error) => console.warn(`Stockfish prewarm failed: ${error.message}`));
  });

  httpServer.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      attempts += 1;
      if (attempts <= maxRetries) {
        console.warn(`Port ${PORT} is in use, retrying in ${retryDelay}ms (${attempts}/${maxRetries})...`);
        setTimeout(() => {
          tryListen();
        }, retryDelay);
        return;
      }
      console.error(`Port ${PORT} is still in use after ${maxRetries} retries.`);
    } else {
      console.error('HTTP server error:', error);
    }
  });

  tryListen();
}

start();
