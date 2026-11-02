const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');
const express = require('express');

const SESSION_COOKIE = 'tieu_tieu_session';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;
const CHARACTER_OPTIONS = {
  gender: ['male', 'female'],
  hairStyle: ['short', 'long'],
  faceStyle: ['A', 'B', 'C'],
  hairColor: ['black', 'brown', 'chestnut', 'blonde'],
  shirtStyle: ['shirt', 'hoodie'],
  shirtColor: ['blue', 'red', 'green', 'yellow', 'purple'],
  pantsColor: ['gray', 'navy', 'brown', 'black'],
  shoesStyle: ['sneakers', 'boots', 'sandals'],
  backpack: ['brown', 'red', 'blue', 'none'],
  accessory: ['none', 'glasses', 'scarf', 'bow'],
};

function validateUsername(value) {
  if (typeof value !== 'string') return null;
  const username = value.trim();
  return USERNAME_PATTERN.test(username) ? username : null;
}

function validatePassword(value) {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') >= 10
    && Buffer.byteLength(value, 'utf8') <= 72;
}

function validateCharacter(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const nickname = typeof value.nickname === 'string'
    ? value.nickname.normalize('NFC').trim()
    : '';
  const nicknameLength = Array.from(nickname).length;
  if (nicknameLength < 2 || nicknameLength > 16
    || !/^[\p{L}\p{M}\p{N}_ -]+$/u.test(nickname)) {
    return null;
  }

  const character = {
    nickname,
    nicknameNormalized: nickname.toLocaleLowerCase('vi-VN'),
  };
  for (const [field, allowedValues] of Object.entries(CHARACTER_OPTIONS)) {
    if (!allowedValues.includes(value[field])) return null;
    character[field] = value[field];
  }
  return character;
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function readCookie(request, name) {
  const header = request.headers.cookie;
  if (!header) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

function setSessionCookie(response, token, secure) {
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_DURATION_MS,
  });
}

function clearSessionCookie(response, secure) {
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
  });
}

function publicUser(user, includeCharacter = true) {
  const result = {
    id: user._id.toString(),
    username: user.username,
    role: user.role,
  };
  if (includeCharacter && user.character) result.character = user.character;
  return result;
}

function createAuthService(db, options = {}) {
  const users = db.collection('users');
  const sessions = db.collection('sessions');
  const gameRewards = db.collection('game_rewards');
  const mongoClient = options.mongoClient;

  async function createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
    await sessions.insertOne({
      tokenHash: hashSessionToken(token),
      userId,
      createdAt: new Date(),
      expiresAt,
    });
    return token;
  }

  async function findUserForToken(token) {
    const session = await sessions.findOne({
      tokenHash: hashSessionToken(token),
      expiresAt: { $gt: new Date() },
    });
    if (!session) return null;
    const user = await users.findOne({
      _id: session.userId,
      status: 'active',
    }, {
      projection: { username: 1, role: 1, character: 1 },
    });
    return user ? { ...user, sessionId: session._id } : null;
  }

  async function createUser(username, password, role = 'student') {
    const passwordHash = await bcrypt.hash(password, 12);
    const user = {
      username,
      normalizedUsername: username.toLowerCase(),
      passwordHash,
      role,
      status: 'active',
      gameStats: { level: 1, exp: 0, xu: 0 },
      inventory: [],
      createdAt: new Date(),
    };
    const result = await users.insertOne(user);
    return { ...user, _id: result.insertedId };
  }

  async function saveCharacter(userId, character) {
    const existing = await users.findOne(
      { _id: userId, status: 'active' },
      { projection: { character: 1 } },
    );
    const equipped = existing && existing.character && existing.character.equipped
      ? existing.character.equipped
      : undefined;
    const nextCharacter = equipped ? { ...character, equipped } : character;
    await users.updateOne(
      { _id: userId, status: 'active' },
      { $set: { character: nextCharacter, updatedAt: new Date() } },
    );
    return nextCharacter;
  }

  async function getAccountData(userId, session) {
    const operationOptions = session ? { session } : undefined;
    const initializeGameStats = () => users.updateOne(
      { _id: userId, gameStats: { $exists: false } },
      { $set: { gameStats: { level: 1, exp: 0, xu: 0 } } },
      operationOptions,
    );
    const initializeInventory = () => users.updateOne(
      { _id: userId, inventory: { $exists: false } },
      { $set: { inventory: [] } },
      operationOptions,
    );
    if (session) {
      await initializeGameStats();
      await initializeInventory();
    } else {
      await Promise.all([initializeGameStats(), initializeInventory()]);
    }

    const user = await users.findOne(
      { _id: userId, status: 'active' },
      { projection: { gameStats: 1, inventory: 1 }, ...operationOptions },
    );
    if (!user) return null;

    const stats = user.gameStats || {};
    const inventory = Array.isArray(user.inventory)
      ? user.inventory
        .filter((item) => item
          && typeof item.itemId === 'string'
          && typeof item.name === 'string'
          && Number.isSafeInteger(item.quantity)
          && item.quantity > 0)
        .map((item) => ({
          itemId: item.itemId,
          name: item.name,
          category: typeof item.category === 'string' ? item.category : 'item',
          quantity: item.quantity,
          ...(typeof item.description === 'string' ? { description: item.description } : {}),
        }))
      : [];

    return {
      stats: {
        level: Number.isSafeInteger(stats.level) && stats.level > 0 ? stats.level : 1,
        exp: Number.isSafeInteger(stats.exp) && stats.exp >= 0 ? stats.exp : 0,
        xu: Number.isSafeInteger(stats.xu) && stats.xu >= 0 ? stats.xu : 0,
      },
      inventory,
    };
  }

  async function grantQuizReward(userId) {
    return grantGameReward(userId, 10, 10);
  }

  async function grantGameReward(userId, exp, xu, rewardId) {
    if (!Number.isSafeInteger(exp) || exp < 0 || !Number.isSafeInteger(xu) || xu < 0
      || (exp === 0 && xu === 0)) {
      throw new Error('Phần thưởng trò chơi không hợp lệ.');
    }
    if (rewardId !== undefined) {
      if (typeof rewardId !== 'string' || !rewardId || rewardId.length > 200 || !mongoClient) {
        throw new Error('Không thể xác nhận mã giao dịch phần thưởng.');
      }
      const session = mongoClient.startSession();
      let rewardResult = null;
      try {
        await session.withTransaction(async () => {
          const existing = await gameRewards.findOne({ _id: rewardId }, { session });
          if (existing) {
            if (existing.userId.toString() !== userId.toString()
              || existing.exp !== exp
              || existing.xu !== xu) {
              throw new Error('Mã giao dịch phần thưởng đã được dùng cho nội dung khác.');
            }
            const account = await getAccountData(userId, session);
            rewardResult = account ? { stats: account.stats } : null;
            return;
          }

          await getAccountData(userId, session);
          const result = await users.updateOne(
            { _id: userId, status: 'active' },
            [{
              $set: {
                'gameStats.level': {
                  $add: [
                    { $ifNull: ['$gameStats.level', 1] },
                    { $floor: { $divide: [{ $add: [{ $ifNull: ['$gameStats.exp', 0] }, exp] }, 100] } },
                  ],
                },
                'gameStats.exp': {
                  $mod: [{ $add: [{ $ifNull: ['$gameStats.exp', 0] }, exp] }, 100],
                },
                'gameStats.xu': { $add: [{ $ifNull: ['$gameStats.xu', 0] }, xu] },
                updatedAt: new Date(),
              },
            }],
            { session },
          );
          if (result.matchedCount !== 1) return;
          const account = await getAccountData(userId, session);
          if (!account) return;
          await gameRewards.insertOne({
            _id: rewardId,
            userId,
            exp,
            xu,
            createdAt: new Date(),
          }, { session });
          rewardResult = { stats: account.stats };
        });
      } finally {
        await session.endSession();
      }
      return rewardResult;
    }

    await getAccountData(userId);
    const result = await users.updateOne(
      { _id: userId, status: 'active' },
      [{
        $set: {
          'gameStats.level': {
            $add: [
              { $ifNull: ['$gameStats.level', 1] },
              { $floor: { $divide: [{ $add: [{ $ifNull: ['$gameStats.exp', 0] }, exp] }, 100] } },
            ],
          },
          'gameStats.exp': {
            $mod: [{ $add: [{ $ifNull: ['$gameStats.exp', 0] }, exp] }, 100],
          },
          'gameStats.xu': { $add: [{ $ifNull: ['$gameStats.xu', 0] }, xu] },
          updatedAt: new Date(),
        },
      }],
    );
    if (result.matchedCount !== 1) return null;
    const account = await getAccountData(userId);
    return account ? { stats: account.stats } : null;
  }

  async function grantGameXu(userId, amount) {
    return grantGameReward(userId, 0, amount);
  }

  return {
    users,
    sessions,
    createSession,
    findUserForToken,
    createUser,
    saveCharacter,
    getAccountData,
    grantGameReward,
    grantGameXu,
    grantQuizReward,
  };
}

function createAuthRouter(auth, options = {}) {
  const router = express.Router();
  const secureCookie = options.secureCookie === true;
  const bootstrapToken = options.bootstrapToken || '';

  router.post('/register', async (request, response, next) => {
    const username = validateUsername(request.body && request.body.username);
    const password = request.body && request.body.password;
    if (!username) {
      return response.status(400).json({
        error: 'Tên đăng nhập cần dài 3-20 ký tự, chỉ gồm chữ, số hoặc dấu gạch dưới.',
      });
    }
    if (!validatePassword(password)) {
      return response.status(400).json({ error: 'Mật khẩu cần dài từ 10 đến 72 byte.' });
    }

    try {
      const user = await auth.createUser(username, password);
      const token = await auth.createSession(user._id);
      setSessionCookie(response, token, secureCookie);
      return response.status(201).json({ user: publicUser(user) });
    } catch (error) {
      if (error && error.code === 11000) {
        return response.status(409).json({ error: 'Tên đăng nhập này đã được sử dụng.' });
      }
      return next(error);
    }
  });

  router.post('/login', async (request, response, next) => {
    const username = validateUsername(request.body && request.body.username);
    const password = request.body && request.body.password;
    if (!username || !validatePassword(password)) {
      return response.status(400).json({ error: 'Tên đăng nhập hoặc mật khẩu không hợp lệ.' });
    }

    try {
      const user = await auth.users.findOne({
        normalizedUsername: username.toLowerCase(),
        status: 'active',
      });
      const validPassword = user
        ? await bcrypt.compare(password, user.passwordHash)
        : await bcrypt.compare(password, '$2a$12$C6UzMDM.H6dfI/f/IKcEe.7UYiGQnF2Q0l5ErmA1NQdJg08RY2mZG');
      if (!user || !validPassword) {
        return response.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng.' });
      }

      const token = await auth.createSession(user._id);
      setSessionCookie(response, token, secureCookie);
      return response.json({ user: publicUser(user) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/bootstrap-admin', async (request, response, next) => {
    const suppliedToken = request.body && request.body.bootstrapToken;
    if (!bootstrapToken) {
      return response.status(404).json({ error: 'Không tìm thấy thao tác này.' });
    }
    if (typeof suppliedToken !== 'string'
      || Buffer.byteLength(suppliedToken) !== Buffer.byteLength(bootstrapToken)
      || !crypto.timingSafeEqual(Buffer.from(suppliedToken), Buffer.from(bootstrapToken))) {
      return response.status(403).json({ error: 'Mã khởi tạo không hợp lệ.' });
    }

    const username = validateUsername(request.body.username);
    const password = request.body.password;
    if (!username || !validatePassword(password)) {
      return response.status(400).json({ error: 'Tên đăng nhập hoặc mật khẩu không hợp lệ.' });
    }

    try {
      const adminExists = await auth.users.findOne({ role: 'admin' }, { projection: { _id: 1 } });
      if (adminExists) {
        return response.status(409).json({ error: 'Tài khoản quản trị đã được khởi tạo.' });
      }
      const user = await auth.createUser(username, password, 'admin');
      const token = await auth.createSession(user._id);
      setSessionCookie(response, token, secureCookie);
      return response.status(201).json({ user: publicUser(user) });
    } catch (error) {
      if (error && error.code === 11000) {
        return response.status(409).json({ error: 'Tên đăng nhập này đã được sử dụng.' });
      }
      return next(error);
    }
  });

  router.get('/me', requireAuthentication(auth), (request, response) => {
    response.json({ user: publicUser(request.authUser) });
  });

  router.get('/account', requireAuthentication(auth), async (request, response, next) => {
    try {
      const account = await auth.getAccountData(request.authUser._id);
      if (!account) return response.status(404).json({ error: 'Không tìm thấy hồ sơ tài khoản.' });
      const equipped = (request.authUser.character && request.authUser.character.equipped) || {};
      return response.json({ account, equipped });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/character', requireAuthentication(auth), async (request, response, next) => {
    const character = validateCharacter(request.body);
    if (!character) {
      return response.status(400).json({ error: 'Kiểm tra lại biệt danh và các lựa chọn nhân vật.' });
    }

    try {
      const saved = await auth.saveCharacter(request.authUser._id, character);
      return response.json({ user: publicUser({ ...request.authUser, character: saved || character }) });
    } catch (error) {
      if (error && error.code === 11000) {
        return response.status(409).json({ error: 'Tên nhân vật này đã được dùng trong lớp K35.' });
      }
      return next(error);
    }
  });

  router.post('/logout', async (request, response, next) => {
    const token = readCookie(request, SESSION_COOKIE);
    try {
      if (token) {
        await auth.sessions.deleteOne({ tokenHash: hashSessionToken(token) });
      }
      clearSessionCookie(response, secureCookie);
      return response.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.get('/admin/users', requireAuthentication(auth), requireRole('admin'), async (request, response, next) => {
    try {
      const users = await auth.users.find({}, {
        projection: { username: 1, role: 1, status: 1, createdAt: 1 },
        sort: { createdAt: -1 },
        limit: 100,
      }).toArray();
      return response.json({ users: users.map((user) => ({
        ...publicUser(user, false),
        status: user.status,
        createdAt: user.createdAt,
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/admin/teachers', requireAuthentication(auth), requireRole('admin'), async (request, response, next) => {
    const username = validateUsername(request.body && request.body.username);
    const password = request.body && request.body.password;
    if (!username) {
      return response.status(400).json({
        error: 'Tên đăng nhập cần dài 3-20 ký tự, chỉ gồm chữ, số hoặc dấu gạch dưới.',
      });
    }
    if (!validatePassword(password)) {
      return response.status(400).json({ error: 'Mật khẩu cần dài từ 10 đến 72 byte.' });
    }

    try {
      const user = await auth.createUser(username, password, 'teacher');
      return response.status(201).json({ user: publicUser(user) });
    } catch (error) {
      if (error && error.code === 11000) {
        return response.status(409).json({ error: 'Tên đăng nhập này đã được sử dụng.' });
      }
      return next(error);
    }
  });

  router.patch('/admin/users/:id/role', requireAuthentication(auth), requireRole('admin'), async (request, response, next) => {
    const { id } = request.params;
    const { role } = request.body || {};
    if (!/^[a-f\d]{24}$/i.test(id) || !['student', 'teacher'].includes(role)) {
      return response.status(400).json({ error: 'Tài khoản hoặc quyền mới không hợp lệ.' });
    }

    try {
      const target = await auth.users.findOne({ _id: new ObjectId(id) }, {
        projection: { username: 1, role: 1 },
      });
      if (!target || target.role === 'admin') {
        return response.status(404).json({ error: 'Không tìm thấy tài khoản phù hợp.' });
      }
      await auth.users.updateOne(
        { _id: target._id },
        { $set: { role, updatedAt: new Date(), updatedBy: request.authUser._id } },
      );
      return response.json({ user: publicUser({ ...target, role }) });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

function requireAuthentication(auth) {
  return async (request, response, next) => {
    const token = readCookie(request, SESSION_COOKIE);
    if (!token) return response.status(401).json({ error: 'Vui lòng đăng nhập.' });

    try {
      const user = await auth.findUserForToken(token);
      if (!user) return response.status(401).json({ error: 'Phiên đăng nhập đã hết hạn.' });
      request.authUser = user;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function requireRole(...roles) {
  return (request, response, next) => {
    if (!request.authUser || !roles.includes(request.authUser.role)) {
      return response.status(403).json({ error: 'Bạn không có quyền thực hiện thao tác này.' });
    }
    return next();
  };
}

module.exports = {
  SESSION_COOKIE,
  CHARACTER_OPTIONS,
  createAuthRouter,
  createAuthService,
  hashSessionToken,
  readCookie,
  requireAuthentication,
  requireRole,
  validatePassword,
  validateCharacter,
  validateUsername,
};
