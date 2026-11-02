// Server real-time cho game lớp học ảo Tiểu Tiểu.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const path = require('path');
const http = require('http');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { MongoClient } = require('mongodb');
const { Server } = require('socket.io');
const { createQuizManager } = require('./quiz');
const { createHanziGameManager } = require('./hanzi');
const { createShopRouter } = require('./shop');
const {
  SESSION_COOKIE,
  createAuthRouter,
  createAuthService,
  readCookie,
} = require('./auth');
const store = require('./store');

const PORT = Number(process.env.PORT) || 3001;
const DB_NAME = process.env.DB_NAME || 'tieu_tieu';
const WORLD = { w: 960, h: 540 };
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#fd79a8'];

async function start() {
  if (!process.env.MONGODB_URI) {
    throw new Error('Thiếu MONGODB_URI. Hãy cấu hình chuỗi kết nối MongoDB Atlas trong file .env ở thư mục gốc.');
  }

  const mongoClient = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  await mongoClient.connect();
  const db = mongoClient.db(DB_NAME);
  const auth = createAuthService(db);

  await Promise.all([
    auth.users.createIndex({ normalizedUsername: 1 }, { unique: true }),
    auth.users.createIndex(
      { role: 1 },
      { unique: true, partialFilterExpression: { role: 'admin' } },
    ),
    auth.users.createIndex(
      { 'character.nicknameNormalized': 1 },
      {
        unique: true,
        partialFilterExpression: { 'character.nicknameNormalized': { $type: 'string' } },
      },
    ),
    auth.sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    auth.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
  store.init();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
  app.use(express.json({ limit: '16kb' }));

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Bạn thử quá nhiều lần. Vui lòng đợi 15 phút rồi thử lại.' },
  });
  app.use('/api/auth/register', authLimiter);
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/bootstrap-admin', authLimiter);
  app.use('/api/auth', createAuthRouter(auth, {
    secureCookie: process.env.NODE_ENV === 'production',
    bootstrapToken: process.env.ADMIN_BOOTSTRAP_TOKEN,
  }));
  app.use('/api/shop', createShopRouter(auth));
  app.use('/vendor/xlsx', express.static(path.join(__dirname, '..', '..', 'node_modules', '@e965', 'xlsx', 'dist')));
  app.use(express.static(path.join(__dirname, '..', '..', 'client')));
  app.get('/health', (request, response) => {
    response.json({ ok: true, rooms: store.roomNames() });
  });
  app.use((error, request, response, next) => {
    console.error('[http] Request failed:', error);
    if (response.headersSent) return next(error);
    return response.status(500).json({ error: 'Máy chủ gặp lỗi. Vui lòng thử lại sau.' });
  });

  const server = http.createServer(app);
  const io = new Server(server);
  const quiz = createQuizManager(io, auth);
  const hanzi = createHanziGameManager(io, auth);

  io.use(async (socket, next) => {
    try {
      const token = readCookie({ headers: socket.request.headers }, SESSION_COOKIE);
      if (!token) return next(new Error('Vui lòng đăng nhập để vào lớp.'));
      const user = await auth.findUserForToken(token);
      if (!user) return next(new Error('Phiên đăng nhập đã hết hạn.'));
      if (!user.character) return next(new Error('Hãy tạo nhân vật trước khi vào lớp.'));
      socket.data.user = user;
      return next();
    } catch (error) {
      console.error('[socket] Authentication failed:', error);
      return next(new Error('Không thể xác thực tài khoản.'));
    }
  });

  function clamp(value, lo, hi) {
    const number = Number(value);
    if (!Number.isFinite(number)) return lo;
    return Math.max(lo, Math.min(hi, number));
  }

  io.on('connection', (socket) => {
    const user = socket.data.user;
    let current = null;

    async function withQuizUser(acknowledge, action) {
      const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
      if (!current) {
        reply({ ok: false, error: 'Hãy vào lớp trước khi chơi.' });
        return;
      }
      try {
        const token = readCookie({ headers: socket.request.headers }, SESSION_COOKIE);
        const currentUser = token ? await auth.findUserForToken(token) : null;
        if (!currentUser) {
          reply({ ok: false, error: 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.' });
          return;
        }
        reply(await action(current.room, currentUser));
      } catch (error) {
        console.error('[quiz] Không thể xác thực hoặc xử lý trò chơi:', error);
        reply({ ok: false, error: 'Không thể xác thực quyền hoặc xử lý trò chơi. Vui lòng thử lại.' });
      }
    }

    socket.on('join', () => {
      if (current) return;
      const room = 'K35';
      const player = {
        id: socket.id,
        userId: user._id.toString(),
        name: user.character.nickname,
        role: user.role,
        character: user.character,
        x: 140 + Math.floor(Math.random() * 240),
        y: 400 + Math.floor(Math.random() * 60),
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
      };
      store.addPlayer(room, player);
      socket.join(room);
      current = { room, id: socket.id };
      socket.emit('joined', { you: player, players: store.playersIn(room) });
      socket.emit('quiz:state', quiz.getPublicState(room));
      socket.emit('hanzi:state', hanzi.getPublicState(room));
      socket.to(room).emit('playerJoined', player);
      console.log(`[room ${room}] + ${user.username} (${store.playersIn(room).length} người)`);
    });

    socket.on('character:sync', async () => {
      if (!current) return;
      try {
        const token = readCookie({ headers: socket.request.headers }, SESSION_COOKIE);
        const freshUser = token ? await auth.findUserForToken(token) : null;
        if (freshUser && freshUser.character) {
          user.character = freshUser.character;
          const player = store.updateCharacter(current.room, current.id, freshUser.character);
          if (player) {
            io.to(current.room).emit('playerUpdated', {
              id: player.id,
              character: player.character,
              name: player.name,
            });
          }
        }
      } catch (error) {
        console.error('[socket] character:sync failed:', error);
      }
    });

    socket.on('move', (payload = {}) => {
      if (!current) return;
      const x = clamp(payload.x, 16, WORLD.w - 16);
      const y = clamp(payload.y, 16, WORLD.h - 16);
      const player = store.updatePosition(current.room, current.id, x, y);
      if (player) {
        socket.to(current.room).emit('playerMoved', { id: player.id, x: player.x, y: player.y });
      }
    });

    socket.on('chat', async (payload = {}) => {
      if (!current) return;
      const text = String(payload.text || '').trim().slice(0, 200);
      if (!text) return;
      if (hanzi.hasActive(current.room) && user.role === 'student') {
        try {
          const result = await withHanziAnswer(current.room, user, text);
          socket.emit('hanzi:answer-result', result);
        } catch (error) {
          console.error('[hanzi] Không thể chấm câu trả lời:', error);
          socket.emit('hanzi:answer-result', {
            ok: false,
            error: 'Không thể chấm câu trả lời. Vui lòng thử lại.',
          });
        }
      }
      io.to(current.room).emit('chat', {
        id: current.id,
        name: user.username,
        text,
      });
    });

    async function withHanziAnswer(room, currentUser, answer) {
      const token = readCookie({ headers: socket.request.headers }, SESSION_COOKIE);
      const freshUser = token ? await auth.findUserForToken(token) : null;
      if (!freshUser) return { ok: false, error: 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.' };
      return hanzi.answer(room, freshUser, answer);
    }

    socket.on('quiz:start', (payload = {}, acknowledge) => withQuizUser(
      acknowledge,
      (room, currentUser) => quiz.start(
        room,
        currentUser,
        payload && payload.questions,
        hanzi.hasActive(room),
      ),
    ));

    socket.on('hanzi:start', (payload = {}, acknowledge) => withQuizUser(
      acknowledge,
      (room, currentUser) => hanzi.start(
        room,
        currentUser,
        payload && payload.questions,
        quiz.getPublicState(room).status === 'active',
      ),
    ));

    socket.on('hanzi:end', (acknowledge) => withQuizUser(
      acknowledge,
      (room, currentUser) => hanzi.end(room, currentUser),
    ));

    socket.on('quiz:next', (acknowledge) => withQuizUser(
      acknowledge,
      (room, currentUser) => quiz.next(room, currentUser),
    ));

    socket.on('quiz:end', (acknowledge) => withQuizUser(
      acknowledge,
      (room, currentUser) => quiz.end(room, currentUser),
    ));

    socket.on('quiz:answer', (payload = {}, acknowledge) => withQuizUser(
      acknowledge,
      (room, currentUser) => quiz.answer(room, currentUser, payload && payload.answer),
    ));

    socket.on('disconnect', () => {
      if (!current) return;
      store.removePlayer(current.room, current.id);
      socket.to(current.room).emit('playerLeft', { id: current.id });
      console.log(`[room ${current.room}] - ${user.username}`);
    });
  });

  server.listen(PORT, () => {
    console.log(`[server] Đang chạy tại http://localhost:${PORT}`);
  });

  async function close() {
    await new Promise((resolve, reject) => {
      io.close((error) => (error ? reject(error) : resolve()));
    });
    await mongoClient.close();
  }

  process.once('SIGINT', () => close().catch((error) => {
    console.error('[server] Không thể đóng kết nối sạch:', error);
    process.exitCode = 1;
  }));
  process.once('SIGTERM', () => close().catch((error) => {
    console.error('[server] Không thể đóng kết nối sạch:', error);
    process.exitCode = 1;
  }));
}

start().catch((error) => {
  console.error('[server] Không thể khởi động:', error.message);
  process.exitCode = 1;
});
