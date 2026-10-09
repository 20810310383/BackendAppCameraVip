import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { createLocationRouter } from './routes/location.js';
import { createStepsRouter } from './routes/steps.js';
import { applyChessMove, INITIAL_FEN, sideToMove } from './services/chess-service.js';
import {
  emitLocationToRecipients,
  getFriendLocationSnapshot,
  setLocationSharing,
  updateSharedLocation,
} from './services/location-sharing-service.js';
import { canUsersMessage } from './services/message-service.js';
import { getStockfishMove, STOCKFISH_SETTINGS, warmStockfish } from './services/stockfish-service.js';
import { verifyEmailTransport } from './services/email-service.js';
import { findAvailableUsername } from './services/username-service.js';
import { hashSessionToken } from './services/session-service.js';
import { warmAppleIdTokenVerificationKeys } from './services/apple-id-token.js';
import { log, startupBanner } from './services/logger.js';

const PORT = Number(process.env.PORT ?? 4000);
const corsOrigin = process.env.CORS_ORIGIN ?? '*';
const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const stickerPacksDirectory = path.resolve(serverDirectory, '../assets/sticker-packs');
const stickerPreviewsDirectory = path.resolve(serverDirectory, '../assets/sticker-previews');
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: corsOrigin, methods: ['GET', 'POST'] } });
const memoryGames = new Map();
let mongoReady = false;
const APP_STORE_URL = 'https://apps.apple.com/us/app/camera-daily/id6818688977';

const friendInviteLandingPage = `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#08131d" />
    <title>Kết bạn trên Camera Daily</title>
    <style>
      :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; color: #edf5fa; background: radial-gradient(circle at 18% 10%, #164a6d 0, transparent 38%), radial-gradient(circle at 90% 88%, #322361 0, transparent 38%), #08131d; }
      main { width: min(100%, 420px); padding: 28px; overflow: hidden; border: 1px solid rgba(157, 217, 255, .24); border-radius: 28px; background: linear-gradient(145deg, rgba(22, 39, 53, .96), rgba(9, 19, 29, .98)); box-shadow: 0 28px 80px rgba(0, 0, 0, .42); }
      .mark { width: 52px; height: 52px; display: grid; place-items: center; border: 1px solid rgba(170, 225, 255, .44); border-radius: 17px; font-size: 25px; background: linear-gradient(145deg, #3f9dcb, #3457be); box-shadow: 0 10px 25px rgba(32, 135, 216, .25); }
      .eyebrow { margin: 21px 0 5px; color: #a3ddff; font-size: 12px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
      h1 { margin: 0; font-size: clamp(25px, 7vw, 31px); line-height: 1.12; letter-spacing: -.03em; }
      p { margin: 12px 0 0; color: #aec1ce; font-size: 15px; line-height: 1.55; }
      .invitee { color: #f5fbff; font-weight: 800; }
      .notice { margin-top: 23px; padding: 13px 14px; border: 1px solid rgba(143, 209, 252, .16); border-radius: 15px; color: #a9c1d1; font-size: 13px; line-height: 1.45; background: rgba(5, 13, 21, .36); }
      .actions { display: grid; gap: 10px; margin-top: 22px; }
      button, a { width: 100%; min-height: 50px; display: flex; align-items: center; justify-content: center; padding: 12px 16px; border-radius: 14px; text-decoration: none; font-size: 15px; font-weight: 800; cursor: pointer; }
      button { border: 0; color: #04131f; background: linear-gradient(135deg, #a5e3ff, #77bcff); box-shadow: 0 12px 28px rgba(72, 161, 228, .2); }
      a { border: 1px solid rgba(177, 215, 235, .25); color: #e2f0f8; background: rgba(23, 40, 52, .7); }
      .foot { margin-top: 18px; color: #7890a1; font-size: 12px; text-align: center; }
      @media (max-width: 390px) { main { padding: 24px 20px; border-radius: 23px; } }
    </style>
  </head>
  <body>
    <main>
      <div class="mark" aria-hidden="true">✦</div>
      <div class="eyebrow">Camera Daily</div>
      <h1 id="title">Mở lời mời kết bạn</h1>
      <p id="description">Đang mở Camera Daily để bạn gửi lời mời kết bạn.</p>
      <div class="notice" id="notice">Nếu bạn chưa cài Camera Daily, bạn sẽ được đưa đến App Store.</div>
      <div class="actions">
        <button id="open-app" type="button">Mở Camera Daily</button>
        <a id="app-store" href="${APP_STORE_URL}">Tải Camera Daily trên App Store</a>
      </div>
      <div class="foot" id="foot">Sau khi cài app, hãy quay lại tin nhắn và mở lại link này.</div>
    </main>
    <script>
      (function () {
        var appStoreUrl = ${JSON.stringify(APP_STORE_URL)};
        var rawUsername = new URLSearchParams(window.location.search).get('u') || '';
        var username = rawUsername.trim().replace(/^@+/, '').toLowerCase();
        var validUsername = /^[a-z0-9_]{3,24}$/.test(username);
        var title = document.getElementById('title');
        var description = document.getElementById('description');
        var notice = document.getElementById('notice');
        var openButton = document.getElementById('open-app');

        if (!validUsername) {
          title.textContent = 'Link mời không hợp lệ';
          description.textContent = 'Link này thiếu thông tin người mời. Bạn vẫn có thể tải Camera Daily từ App Store.';
          notice.textContent = 'Hãy xin lại một link mời mới từ bạn bè của bạn.';
          openButton.style.display = 'none';
          return;
        }

        description.innerHTML = 'Bạn sắp gửi lời mời kết bạn tới <span class="invitee">@' + username + '</span>.';
        var deepLink = 'cameradaily://friend-add?username=' + encodeURIComponent(username);
        var fallbackTimer;
        function openApp() {
          window.location.href = deepLink;
          window.clearTimeout(fallbackTimer);
          fallbackTimer = window.setTimeout(function () {
            if (!document.hidden) window.location.href = appStoreUrl;
          }, 1400);
        }
        document.addEventListener('visibilitychange', function () {
          if (document.hidden) window.clearTimeout(fallbackTimer);
        });
        openButton.addEventListener('click', openApp);
        window.setTimeout(openApp, 350);
      }());
    </script>
  </body>
</html>`;

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
// These are optional, versioned app assets. Keeping them outside `uploads` means
// they are deployed with the backend, but never bundled into the mobile app.
app.use('/stickers', express.static(stickerPacksDirectory, { immutable: true, maxAge: '365d' }));
app.use('/sticker-previews', express.static(stickerPreviewsDirectory, { immutable: true, maxAge: '365d' }));
app.use('/uploads', express.static(uploadsDirectory, { immutable: true, maxAge: '30d' }));
app.get('/invite', (_request, response) => {
  response
    .set('Cache-Control', 'no-store')
    .set('Referrer-Policy', 'no-referrer')
    .type('html')
    .send(friendInviteLandingPage);
});
app.use('/api/auth', createAuthRouter({ isDatabaseReady: () => mongoReady }));
app.use('/api/auth', createSessionRouter({
  isDatabaseReady: () => mongoReady,
  emitSocialEvent,
}));
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
app.use('/api', createLocationRouter({
  isDatabaseReady: () => mongoReady,
  emitSocialEvent,
}));
app.use('/api', createStepsRouter({ isDatabaseReady: () => mongoReady }));
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
      if (previousUserId && previousUserId !== session.userId.toString()) {
        socket.leave(socialRoom(previousUserId));
      }

      socket.data.socialUserId = session.userId.toString();
      socket.join(socialRoom(session.userId));
      const lastActiveAt = new Date();
      await User.updateOne({ _id: session.userId }, { $set: { lastActiveAt } });
      await notifyFriendsOfPresence(session.userId, true, lastActiveAt);
      respond({ ok: true });
    } catch (error) {
      log.failure('SOCKET', error);
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
      log.failure('SOCKET', error);
    }
  });

  socket.on('map:location-snapshot', async (_payload = {}, callback) => {
    const respond = callbackOrNoop(callback);
    try {
      if (!mongoReady || !socket.data.socialUserId) return respond({ error: 'Vui lòng kết nối tài khoản trước.' });
      return respond({ ok: true, locations: await getFriendLocationSnapshot(socket.data.socialUserId) });
    } catch (error) {
      log.failure('MAP', error);
      return respond({ error: 'Không thể tải vị trí bạn bè lúc này.' });
    }
  });

  socket.on('map:location-update', async (payload = {}, callback) => {
    const respond = callbackOrNoop(callback);
    try {
      if (!mongoReady || !socket.data.socialUserId) return respond({ error: 'Vui lòng kết nối tài khoản trước.' });

      const user = await User.findById(socket.data.socialUserId).select('fullName username avatarPath friends locationSharingEnabled locationSharingRecipientIds sharedLocation locationTrail');
      if (!user) return respond({ error: 'Không tìm thấy tài khoản.' });

      const location = await updateSharedLocation(user, payload);
      if (location) emitLocationToRecipients(user, emitSocialEvent, 'map:location-updated', location);
      return respond({ ok: true });
    } catch (error) {
      log.failure('MAP', error);
      return respond({ error: 'Không thể cập nhật vị trí lúc này.' });
    }
  });

  socket.on('map:location-stop', async (_payload = {}, callback) => {
    const respond = callbackOrNoop(callback);
    try {
      if (!socket.data.socialUserId) return respond({ ok: true });
      const user = await User.findById(socket.data.socialUserId).select('friends locationSharingRecipientIds');
      if (user) {
        await setLocationSharing(user, false);
        emitLocationToRecipients(user, emitSocialEvent, 'map:location-stopped', { userId: user._id.toString() });
      }
      return respond({ ok: true });
    } catch (error) {
      log.failure('MAP', error);
      return respond({ error: 'Không thể dừng chia sẻ vị trí lúc này.' });
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
          .catch((error) => log.failure('SOCKET', error));
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
  log.warn('SYSTEM', `Nhận ${signal} · đang đóng kết nối an toàn…`);
  try {
    io.close();
    if (typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }
    await new Promise((resolve) => httpServer.close(resolve));
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  } catch (error) {
    log.failure('SYSTEM', error);
  } finally {
    log.info('SYSTEM', 'Đã tắt máy chủ · hẹn gặp lại ✦');
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
      log.success('MONGO', 'Đã kết nối · sẵn sàng phục vụ khoảnh khắc, chat và bạn bè');
      await backfillUsernames().catch((error) => log.failure('MONGO', error));
      await Promise.allSettled([
        User.createIndexes(),
        FriendRequest.createIndexes(),
        Message.createIndexes(),
        migrateSharedChainIndexes(),
      ]);
      void verifyEmailTransport()
        .then((ready) => (ready ? log.success('EMAIL', 'Kênh gửi email đã sẵn sàng') : log.warn('EMAIL', 'Chưa cấu hình kênh gửi email')))
        .catch((error) => log.failure('EMAIL', error));
    } catch (error) {
      log.warn('MONGO', `Không thể kết nối · tạm dùng bộ nhớ cho ván cờ (${error.message})`);
    }
  } else {
    log.warn('MONGO', 'Chưa có MONGODB_URI · dùng bộ nhớ tạm cho chế độ demo');
  }

  let attempts = 0;
  const maxRetries = 10;
  const retryDelay = 600;

  function tryListen() {
    httpServer.listen(PORT, '0.0.0.0');
  }

  httpServer.on('listening', () => {
    startupBanner({ port: PORT, databaseReady: mongoReady });
    void warmStockfish().then(() => log.success('CHESS', 'Stockfish đã sẵn sàng')).catch((error) => log.failure('CHESS', error));
    void warmAppleIdTokenVerificationKeys().then((status) => {
      if (status.source === 'remote' || status.source === 'cache') {
        log.success('AUTH', `Đã sẵn sàng xác minh Apple Sign In (${status.keyCount} khóa).`);
      } else {
        log.warn('AUTH', `Đang dùng khóa Apple dự phòng (${status.keyCount} khóa). Kiểm tra outbound HTTPS tới appleid.apple.com: ${status.refreshError}`);
      }
    }).catch((error) => log.failure('AUTH', error));
  });

  httpServer.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      attempts += 1;
      if (attempts <= maxRetries) {
        log.warn('HTTP', `Cổng ${PORT} đang bận · thử lại sau ${retryDelay}ms (${attempts}/${maxRetries})`);
        setTimeout(() => {
          tryListen();
        }, retryDelay);
        return;
      }
      log.error('HTTP', `Cổng ${PORT} vẫn bận sau ${maxRetries} lần thử`);
    } else {
      log.failure('HTTP', error);
    }
  });

  tryListen();
}

start();
