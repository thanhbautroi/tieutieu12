const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { MongoClient } = require('mongodb');
const { createAdapter } = require('@socket.io/mongo-adapter');
const { createPersistentGameManager } = require('./persistent-game-manager');
const { createMongoGameStateStore } = require('./game-state-store');
const { normalizeQuestions } = require('./quiz');
const { normalizeHanziQuestions, normalizeMeaning } = require('./hanzi');
const { createShopRouter } = require('./shop');
const {
  SESSION_COOKIE,
  createAuthRouter,
  createAuthService,
  readCookie,
} = require('./auth');

const DB_NAME = process.env.DB_NAME || 'tieu_tieu';
const WORLD = { w: 960, h: 540 };
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#fd79a8'];
let runtimePromise;
let apiPromise;

async function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      if (!process.env.MONGODB_URI) {
        throw new Error('Thiếu MONGODB_URI. Hãy cấu hình biến môi trường MongoDB Atlas.');
      }

      const mongoClient = new MongoClient(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 10000,
      });
      await mongoClient.connect();
      const db = mongoClient.db(DB_NAME);
      const auth = createAuthService(db, { mongoClient });

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

      return {
        db,
        mongoClient,
        auth,
        gameStateStore: createMongoGameStateStore(db.collection('room_game_states')),
      };
    })().catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

async function createApiApp() {
  const runtime = await getRuntime();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.VERCEL === '1' || process.env.TRUST_PROXY === '1' ? 1 : false);
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
  app.use('/api/auth', createAuthRouter(runtime.auth, {
    secureCookie: process.env.NODE_ENV === 'production',
    bootstrapToken: process.env.ADMIN_BOOTSTRAP_TOKEN,
  }));
  app.use('/api/shop', createShopRouter(runtime.auth));
  app.use('/api/vendor/xlsx', express.static(
    path.join(__dirname, '..', '..', 'node_modules', '@e965', 'xlsx', 'dist'),
  ));
  app.use(express.static(path.join(__dirname, '..', '..', 'client')));
  app.get('/api/health', (request, response) => {
    response.json({ ok: true });
  });
  app.use((error, request, response, next) => {
    console.error('[http] Request failed:', error);
    if (response.headersSent) return next(error);
    return response.status(500).json({ error: 'Máy chủ gặp lỗi. Vui lòng thử lại sau.' });
  });
  return app;
}

async function handleSocketConnection(io, runtime, quiz, hanzi, socket) {
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
      const currentUser = token ? await runtime.auth.findUserForToken(token) : null;
      if (!currentUser) {
        reply({ ok: false, error: 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.' });
        return;
      }
      reply(await action(current.room, currentUser));
    } catch (error) {
      console.error('[game] Không thể xác thực hoặc xử lý trò chơi:', error);
      reply({ ok: false, error: 'Không thể xác thực quyền hoặc xử lý trò chơi. Vui lòng thử lại.' });
    }
  }

  socket.on('join', async () => {
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
    socket.data.player = player;
    await socket.join(room);
    current = { room, id: socket.id };
    try {
      const [roomSockets, quizState, hanziState] = await Promise.all([
        io.in(room).fetchSockets(),
        quiz.getPublicState(room),
        hanzi.getPublicState(room),
      ]);
      const players = roomSockets.map((entry) => entry.data.player).filter(Boolean);
      socket.emit('joined', { you: player, players });
      socket.emit('quiz:state', quizState);
      socket.emit('hanzi:state', hanziState);
      socket.to(room).emit('playerJoined', player);
      console.log(`[room ${room}] + ${user.username} (${players.length} người)`);
    } catch (error) {
      console.error('[socket] Không thể tham gia phòng:', error);
      socket.emit('game:error', { error: 'Không thể tải trạng thái lớp học. Vui lòng thử lại.' });
    }
  });

  socket.on('character:sync', async () => {
    if (!current) return;
    try {
      const token = readCookie({ headers: socket.request.headers }, SESSION_COOKIE);
      const freshUser = token ? await runtime.auth.findUserForToken(token) : null;
      if (!freshUser || !freshUser.character) return;
      user.character = freshUser.character;
      socket.data.player = {
        ...socket.data.player,
        character: freshUser.character,
        name: freshUser.character.nickname || socket.data.player.name,
      };
      io.to(current.room).emit('playerUpdated', {
        id: socket.id,
        character: socket.data.player.character,
        name: socket.data.player.name,
      });
    } catch (error) {
      console.error('[socket] character:sync failed:', error);
    }
  });

  socket.on('move', (payload = {}) => {
    if (!current || !socket.data.player) return;
    const clamp = (value, low, high) => {
      const number = Number(value);
      if (!Number.isFinite(number)) return low;
      return Math.max(low, Math.min(high, number));
    };
    socket.data.player.x = clamp(payload.x, 16, WORLD.w - 16);
    socket.data.player.y = clamp(payload.y, 16, WORLD.h - 16);
    socket.to(current.room).emit('playerMoved', {
      id: socket.id,
      x: socket.data.player.x,
      y: socket.data.player.y,
    });
  });

  socket.on('chat', async (payload = {}) => {
    if (!current) return;
    const text = String(payload.text || '').trim().slice(0, 200);
    if (!text) return;
    if (user.role === 'student' && await hanzi.hasActive(current.room)) {
      try {
        const token = readCookie({ headers: socket.request.headers }, SESSION_COOKIE);
        const freshUser = token ? await runtime.auth.findUserForToken(token) : null;
        const result = freshUser
          ? await hanzi.answer(current.room, freshUser, text)
          : { ok: false, error: 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.' };
        socket.emit('hanzi:answer-result', result);
      } catch (error) {
        console.error('[hanzi] Không thể chấm câu trả lời:', error);
        socket.emit('hanzi:answer-result', {
          ok: false,
          error: 'Không thể chấm câu trả lời. Vui lòng thử lại.',
        });
      }
    }
    io.to(current.room).emit('chat', { id: current.id, name: user.username, text });
  });

  socket.on('quiz:start', (payload = {}, acknowledge) => withQuizUser(
    acknowledge,
    async (room, currentUser) => quiz.start(
      room,
      currentUser,
      payload && payload.questions,
      await hanzi.hasActive(room),
    ),
  ));
  socket.on('hanzi:start', (payload = {}, acknowledge) => withQuizUser(
    acknowledge,
    async (room, currentUser) => hanzi.start(
      room,
      currentUser,
      payload && payload.questions,
      await quiz.hasActive(room),
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
  socket.on('game:tick', async () => {
    if (!current) return;
    try {
      await Promise.all([quiz.refresh(current.room), hanzi.refresh(current.room)]);
    } catch (error) {
      console.error('[game] Không thể kiểm tra thời gian câu hỏi:', error);
    }
  });
  socket.on('disconnect', () => {
    if (!current) return;
    socket.to(current.room).emit('playerLeft', { id: current.id });
    console.log(`[room ${current.room}] - ${user.username}`);
  });
}

function initializeSocketServer(io) {
  const runtimePromise = getRuntime();
  const ready = runtimePromise.then(async (runtime) => {
    const adapterCollection = runtime.db.collection('socket_io_adapter_events');
    await adapterCollection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 });
    io.adapter(createAdapter(adapterCollection, { addCreatedAtField: true }));

    const quiz = createPersistentGameManager(io, runtime.auth, runtime.gameStateStore, {
      gameType: 'quiz',
      eventName: 'quiz:state',
      normalize: normalizeQuestions,
      invalidQuestionsMessage: 'Bộ câu hỏi không hợp lệ. Hãy nhập từ 1 đến 100 câu, mỗi câu có đủ 4 đáp án.',
      oneAttempt: true,
      evaluate: (answer) => ({
        valid: typeof answer === 'string' && /^[A-D]$/i.test(answer),
        error: 'Đáp án không hợp lệ.',
        isCorrect: (question) => answer.toUpperCase() === question.correctAnswer,
      }),
    });
    const hanzi = createPersistentGameManager(io, runtime.auth, runtime.gameStateStore, {
      gameType: 'hanzi',
      eventName: 'hanzi:state',
      normalize: normalizeHanziQuestions,
      invalidQuestionsMessage: 'Bộ câu hỏi không hợp lệ. Hãy nhập từ 1 đến 100 dòng gồm chữ Hán và nghĩa tiếng Việt.',
      oneAttempt: false,
      evaluate: (answer) => {
        const normalized = normalizeMeaning(answer);
        return {
          valid: Boolean(normalized),
          error: 'Hãy nhập nghĩa tiếng Việt vào khung chat.',
          isCorrect: (question) => question.meanings.some((meaning) => normalizeMeaning(meaning) === normalized),
        };
      },
    });

    io.on('connection', (socket) => {
      handleSocketConnection(io, runtime, quiz, hanzi, socket).catch((error) => {
        console.error('[socket] Không thể khởi tạo kết nối:', error);
        socket.disconnect(true);
      });
    });
  });

  io.use(async (socket, next) => {
    try {
      const runtime = await runtimePromise;
      await ready;
      const token = readCookie({ headers: socket.request.headers }, SESSION_COOKIE);
      if (!token) return next(new Error('Vui lòng đăng nhập để vào lớp.'));
      const user = await runtime.auth.findUserForToken(token);
      if (!user) return next(new Error('Phiên đăng nhập đã hết hạn.'));
      if (!user.character) return next(new Error('Hãy tạo nhân vật trước khi vào lớp.'));
      socket.data.user = user;
      return next();
    } catch (error) {
      console.error('[socket] Authentication failed:', error);
      return next(new Error('Không thể xác thực tài khoản.'));
    }
  });
  return ready;
}

function getApiHandler() {
  return async (request, response) => {
    try {
      if (!apiPromise) {
        apiPromise = createApiApp().catch((error) => {
          apiPromise = null;
          throw error;
        });
      }
      const app = await apiPromise;
      app(request, response);
    } catch (error) {
      console.error('[vercel] API initialization failed:', error);
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: 'Máy chủ chưa sẵn sàng. Vui lòng thử lại sau.' }));
    }
  };
}

module.exports = { getApiHandler, initializeSocketServer };
