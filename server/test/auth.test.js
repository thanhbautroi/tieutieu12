const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { ObjectId } = require('mongodb');
const {
  createAuthRouter,
  createAuthService,
  hashSessionToken,
  validateCharacter,
  validatePassword,
  validateUsername,
} = require('../src/auth');
const { createQuizManager, normalizeQuestions } = require('../src/quiz');
const { createHanziGameManager, normalizeHanziQuestions, normalizeMeaning } = require('../src/hanzi');
const { createPersistentGameManager } = require('../src/persistent-game-manager');
const {
  createMemoryGameStateStore,
  createMongoGameStateStore,
} = require('../src/game-state-store');
const { createShopRouter } = require('../src/shop');

function matches(document, query) {
  return Object.entries(query).every(([key, expected]) => {
    const value = key.split('.').reduce((current, part) => current && current[part], document);
    if (expected && expected.$gt) return value > expected.$gt;
    if (expected && typeof expected === 'object' && '$exists' in expected) {
      return (value !== undefined) === expected.$exists;
    }
    if (expected && typeof expected === 'object' && '$gte' in expected) {
      return value >= expected.$gte;
    }
    if (expected && typeof expected === 'object' && '$not' in expected) {
      const { $elemMatch: elementQuery } = expected.$not;
      return !value.some((element) => matches(element, elementQuery));
    }
    if (value instanceof ObjectId && expected instanceof ObjectId) {
      return value.toString() === expected.toString();
    }
    return value === expected;
  });
}

function setPath(document, path, value) {
  const keys = path.split('.');
  let target = document;
  for (const key of keys.slice(0, -1)) target = target[key] || (target[key] = {});
  target[keys[keys.length - 1]] = value;
}

function evaluateUpdateExpression(expression, document) {
  if (Array.isArray(expression)) return expression.map((item) => evaluateUpdateExpression(item, document));
  if (typeof expression === 'string' && expression.startsWith('$')) {
    return expression.slice(1).split('.').reduce((value, key) => value && value[key], document);
  }
  if (!expression || typeof expression !== 'object' || expression instanceof Date) return expression;
  const [operator] = Object.keys(expression);
  if (operator === '$ifNull') {
    const [value, fallback] = expression.$ifNull.map((item) => evaluateUpdateExpression(item, document));
    return value == null ? fallback : value;
  }
  if (operator === '$add' || operator === '$divide' || operator === '$mod') {
    const [left, right] = expression[operator].map((item) => evaluateUpdateExpression(item, document));
    if (operator === '$add') return left + right;
    if (operator === '$divide') return left / right;
    return left % right;
  }
  if (operator === '$floor') return Math.floor(evaluateUpdateExpression(expression.$floor, document));
  return expression;
}

function createMockDatabase() {
  const users = [];
  const sessions = [];
  const gameRewards = [];
  return {
    collection(name) {
      const documents = name === 'users'
        ? users
        : name === 'game_rewards' ? gameRewards : sessions;
      return {
        async insertOne(document) {
          if (name === 'users' && users.some((user) =>
            user.normalizedUsername === document.normalizedUsername
            || (document.role === 'admin' && user.role === 'admin')
            || (document.character
              && user.character
              && user.character.nicknameNormalized === document.character.nicknameNormalized))) {
            const error = new Error('Duplicate key');
            error.code = 11000;
            throw error;
          }
          const inserted = { ...document, _id: document._id || new ObjectId() };
          documents.push(inserted);
          return { insertedId: inserted._id };
        },
        async findOne(query) {
          return documents.find((document) => matches(document, query)) || null;
        },
        async deleteOne(query) {
          const index = documents.findIndex((document) => matches(document, query));
          if (index >= 0) documents.splice(index, 1);
          return { deletedCount: index >= 0 ? 1 : 0 };
        },
        async updateOne(query, update) {
          const document = documents.find((candidate) => matches(candidate, query));
          if (document) {
            const directSet = Array.isArray(update) ? {} : (update.$set || {});
            if (name === 'users' && directSet.character && users.some((user) =>
              user !== document
              && user.character
              && user.character.nicknameNormalized === directSet.character.nicknameNormalized)) {
              const error = new Error('Duplicate key');
              error.code = 11000;
              throw error;
            }
            if (Array.isArray(update)) {
              for (const stage of update) {
                const values = Object.fromEntries(
                  Object.entries(stage.$set || {}).map(([field, value]) => [
                    field,
                    evaluateUpdateExpression(value, document),
                  ]),
                );
                for (const [field, value] of Object.entries(values)) setPath(document, field, value);
              }
            }
            Object.assign(document, directSet);
            for (const [field, amount] of Object.entries(update.$inc || {})) {
              const current = field.split('.').reduce((value, key) => value && value[key], document) || 0;
              setPath(document, field, current + amount);
            }
            for (const [field, value] of Object.entries(update.$push || {})) {
              const current = field.split('.').reduce((entry, key) => entry && entry[key], document);
              current.push(value);
            }
          }
          return {
            matchedCount: document ? 1 : 0,
            modifiedCount: document ? 1 : 0,
          };
        },
        find(query) {
          let result = documents.filter((document) => matches(document, query));
          return {
            sort() { result = result.slice().reverse(); return this; },
            limit(maximum) { result = result.slice(0, maximum); return this; },
            async toArray() { return result; },
          };
        },
      };
    },
  };
}

test('username validation accepts the supported format', () => {
  assert.equal(validateUsername('minh_01'), 'minh_01');
  assert.equal(validateUsername('  minh  '), 'minh');
});

test('username validation rejects invalid length and characters', () => {
  assert.equal(validateUsername('ab'), null);
  assert.equal(validateUsername('minh tien'), null);
  assert.equal(validateUsername('tên'), null);
  assert.equal(validateUsername('a'.repeat(21)), null);
  assert.equal(validateUsername(null), null);
});

test('password validation enforces bcrypt byte limits', () => {
  assert.equal(validatePassword('short'), false);
  assert.equal(validatePassword('long-enough-password'), true);
  assert.equal(validatePassword('đ'.repeat(37)), false);
  assert.equal(validatePassword(null), false);
});

test('session tokens are stored as deterministic SHA-256 digests', () => {
  const token = 'sample-session-token';
  const hash = hashSessionToken(token);
  assert.notEqual(hash, token);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hashSessionToken(token), hash);
});

const validCharacter = {
  nickname: 'Mình 01',
  gender: 'female',
  hairStyle: 'long',
  faceStyle: 'B',
  hairColor: 'chestnut',
  shirtStyle: 'hoodie',
  shirtColor: 'purple',
  pantsColor: 'navy',
  shoesStyle: 'sandals',
  backpack: 'none',
  accessory: 'glasses',
};

test('character validation accepts Vietnamese nicknames and only known appearance options', () => {
  const character = validateCharacter(validCharacter);
  assert.equal(character.nickname, 'Mình 01');
  assert.equal(character.nicknameNormalized, 'mình 01');
  assert.equal(character.accessory, 'glasses');
  assert.equal(validateCharacter({ ...validCharacter, nickname: 'x' }), null);
  assert.equal(validateCharacter({ ...validCharacter, shirtColor: 'javascript:alert(1)' }), null);
  assert.equal(validateCharacter({ ...validCharacter, nickname: '<script>' }), null);
});

test('account stats and inventory are isolated per user and legacy accounts are initialized', async () => {
  const db = createMockDatabase();
  const users = db.collection('users');
  const firstUser = await users.insertOne({
    username: 'owner_one',
    normalizedUsername: 'owner_one',
    role: 'student',
    status: 'active',
    gameStats: { level: 4, exp: 25, xu: 90 },
    inventory: [{
      itemId: 'red-book',
      name: 'Sách đỏ',
      category: 'item',
      quantity: 2,
    }],
  });
  const secondUser = await users.insertOne({
    username: 'owner_two',
    normalizedUsername: 'owner_two',
    role: 'student',
    status: 'active',
  });
  const auth = createAuthService(db);

  assert.deepEqual(await auth.getAccountData(firstUser.insertedId), {
    stats: { level: 4, exp: 25, xu: 90 },
    inventory: [{
      itemId: 'red-book',
      name: 'Sách đỏ',
      category: 'item',
      quantity: 2,
    }],
  });
  assert.deepEqual(await auth.getAccountData(secondUser.insertedId), {
    stats: { level: 1, exp: 0, xu: 0 },
    inventory: [],
  });
});

test('game rewards add EXP and Xu atomically and level up at every 100 EXP', async () => {
  const db = createMockDatabase();
  const users = db.collection('users');
  const firstUser = await users.insertOne({
    username: 'quiz_player_1',
    normalizedUsername: 'quiz_player_1',
    role: 'student',
    status: 'active',
    gameStats: { level: 1, exp: 90, xu: 5 },
  });
  const secondUser = await users.insertOne({
    username: 'quiz_player_2',
    normalizedUsername: 'quiz_player_2',
    role: 'student',
    status: 'active',
    gameStats: { level: 3, exp: 95, xu: 20 },
  });
  const auth = createAuthService(db);

  assert.deepEqual(await auth.grantQuizReward(firstUser.insertedId), {
    stats: { level: 2, exp: 0, xu: 15 },
  });
  assert.deepEqual(await auth.grantGameReward(secondUser.insertedId, 20, 20), {
    stats: { level: 4, exp: 15, xu: 40 },
  });
});

test('game reward transaction keys make retries idempotent', async () => {
  const db = createMockDatabase();
  const mongoClient = {
    startSession() {
      return {
        async withTransaction(operation) {
          await operation();
        },
        async endSession() {},
      };
    },
  };
  const auth = createAuthService(db, { mongoClient });
  const user = await auth.createUser('reward_retry', 'reward-retry-password');
  const rewardId = 'game-1:0:student-1';

  const first = await auth.grantGameReward(user._id, 20, 20, rewardId);
  const retry = await auth.grantGameReward(user._id, 20, 20, rewardId);
  assert.deepEqual(retry, first);
  assert.equal(retry.stats.exp, 20);
  assert.equal(retry.stats.xu, 20);
  await assert.rejects(
    auth.grantGameReward(user._id, 30, 20, rewardId),
    /đã được dùng/,
  );
});

test('Mongo game state store uses version checks for concurrent updates', async () => {
  const db = createMockDatabase();
  const store = createMongoGameStateStore(db.collection('room_game_states'));
  assert.equal(await store.insert('K35', { gameType: 'quiz', status: 'active' }), true);
  const first = await store.read('K35');
  assert.equal(first.version, 1);
  assert.equal(await store.compareAndSet('K35', first.version, {
    gameType: 'quiz',
    status: 'finished',
  }), true);
  assert.equal(await store.compareAndSet('K35', first.version, {
    gameType: 'quiz',
    status: 'active',
  }), false);
  assert.equal((await store.read('K35')).state.status, 'finished');
});

test('game Xu rewards increment only the active user balance', async () => {
  const db = createMockDatabase();
  const auth = createAuthService(db);
  const user = await auth.createUser('hanzi_player', 'hanzi-player-password');
  const reward = await auth.grantGameReward(user._id, 20, 20);
  assert.deepEqual(reward, { stats: { level: 1, exp: 20, xu: 20 } });
  assert.equal((await auth.getAccountData(user._id)).stats.xu, 20);
  await assert.rejects(() => auth.grantGameXu(user._id, 0), /Phần thưởng trò chơi không hợp lệ/);
});

test('Hanzi game accepts case and accent-insensitive meanings and rewards the first five students', async () => {
  const questions = [{ hanzi: '你好', meanings: ['Xin chào', 'chào bạn'] }];
  assert.equal(normalizeHanziQuestions(questions).length, 1);
  assert.equal(normalizeHanziQuestions([{ hanzi: '', meanings: ['Xin chào'] }]), null);
  assert.equal(normalizeMeaning('  XIN   CHÀO! '), 'xin chao');

  const emitted = [];
  const rewards = [];
  const manager = createHanziGameManager({
    to(room) {
      return { emit(event, payload) { emitted.push({ room, event, payload }); } };
    },
  }, {
    async grantGameReward(userId, exp, xu) {
      rewards.push({ userId: userId.toString(), exp, xu });
      return { stats: { level: 1, exp: rewards.length * 20, xu: rewards.length * 20 } };
    },
  }, { roundDurationMs: 5000 });
  const teacher = { role: 'teacher' };
  assert.equal(manager.start('K35', { role: 'student' }, questions).ok, false);
  assert.equal(manager.start('K35', teacher, questions, true).ok, false);
  assert.equal(manager.start('K35', teacher, questions).ok, true);

  const first = { _id: new ObjectId(), role: 'student', character: { nickname: 'Nhanh nhất' } };
  assert.deepEqual(await manager.answer('K35', first, 'tam biet'), { ok: true, correct: false });
  for (let index = 0; index < 5; index += 1) {
    const user = {
      _id: new ObjectId(),
      role: 'student',
      character: { nickname: `Bạn ${index + 1}` },
    };
    const result = await manager.answer('K35', user, index === 0 ? 'XIN CHAO' : 'xin chao');
    assert.equal(result.correct, true);
    assert.equal(result.rank, index + 1);
    assert.equal(result.stats.exp, (index + 1) * 20);
    assert.equal(result.stats.xu, (index + 1) * 20);
  }
  const sixth = await manager.answer(
    'K35',
    { _id: new ObjectId(), role: 'student', character: { nickname: 'Bạn thứ sáu' } },
    'xin chào',
  );
  assert.equal(sixth.ok, false);
  assert.equal(rewards.length, 5);
  assert.ok(rewards.every((reward) => reward.exp === 20 && reward.xu === 20));
  assert.deepEqual(manager.getPublicState('K35').winners.map((winner) => winner.rank), [1, 2, 3, 4, 5]);
  assert.equal(emitted.at(-1).event, 'hanzi:state');
  manager.end('K35', teacher);
});

test('Hanzi game advances automatically after the 30-second answer window', async () => {
  const manager = createHanziGameManager({
    to() { return { emit() {} }; },
  }, { grantGameReward: async () => ({ stats: { level: 1, exp: 20, xu: 20 } }) }, {
    roundDurationMs: 25,
  });
  manager.start('K35', { role: 'admin' }, [
    { hanzi: '你好', meanings: ['xin chào'] },
    { hanzi: '谢谢', meanings: ['cảm ơn'] },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(manager.getPublicState('K35').questionNumber, 2);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(manager.getPublicState('K35').status, 'finished');
});

test('quiz manager awards the first five correct students within each timed question', async () => {
  const questions = [{
    question: '你好 nghĩa là gì?',
    answers: { A: 'Xin chào', B: 'Tạm biệt', C: 'Cảm ơn', D: 'Xin lỗi' },
    correctAnswer: 'A',
    explanation: '你好 là xin chào.',
  }];
  assert.equal(normalizeQuestions(questions).length, 1);
  assert.equal(normalizeQuestions([]), null);
  assert.equal(normalizeQuestions([{ ...questions[0], correctAnswer: 'E' }]), null);

  const emitted = [];
  let releaseReward;
  let rewardCalls = 0;
  const rewardGate = new Promise((resolve) => { releaseReward = resolve; });
  const manager = createQuizManager({
    to(room) {
      return { emit(event, payload) { emitted.push({ room, event, payload }); } };
    },
  }, {
    async grantGameReward(userId, exp, xu) {
      rewardCalls += 1;
      await rewardGate;
      return { stats: { level: 1, exp, xu } };
    },
  }, { roundDurationMs: 5000 });
  const teacher = { role: 'teacher' };
  const student = {
    _id: new ObjectId(),
    role: 'student',
    character: { nickname: 'Bạn Nhanh' },
  };
  const otherStudent = {
    _id: new ObjectId(),
    role: 'student',
    character: { nickname: 'Bạn Khác' },
  };
  const thirdStudent = {
    _id: new ObjectId(),
    role: 'student',
    character: { nickname: 'Bạn Trả Sai' },
  };

  assert.equal(manager.start('K35', { role: 'student' }, questions).ok, false);
  assert.equal(manager.start('K35', teacher, questions).ok, true);
  const publicQuestion = manager.getPublicState('K35');
  assert.ok(Number.isFinite(publicQuestion.endsAt));
  assert.equal(Object.hasOwn(publicQuestion.question, 'correctAnswer'), false);
  assert.equal(Object.hasOwn(publicQuestion, 'explanation'), false);
  const wrongAnswer = await manager.answer('K35', thirdStudent, 'B');
  assert.deepEqual(wrongAnswer, { ok: true, correct: false });
  assert.equal((await manager.answer('K35', thirdStudent, 'A')).ok, false);
  const winnerPromise = manager.answer('K35', student, 'A');
  const concurrentAnswer = manager.answer('K35', otherStudent, 'A');
  const thirdCorrectStudent = {
    _id: new ObjectId(),
    role: 'student',
    character: { nickname: 'Bạn đúng thứ ba' },
  };
  const fourthCorrectStudent = {
    _id: new ObjectId(),
    role: 'student',
    character: { nickname: 'Bạn đúng thứ tư' },
  };
  const fifthCorrectStudent = {
    _id: new ObjectId(),
    role: 'student',
    character: { nickname: 'Bạn đúng thứ năm' },
  };
  const sixthCorrectStudent = {
    _id: new ObjectId(),
    role: 'student',
    character: { nickname: 'Bạn đúng thứ sáu' },
  };
  const thirdPromise = manager.answer('K35', thirdCorrectStudent, 'A');
  const fourthPromise = manager.answer('K35', fourthCorrectStudent, 'A');
  const fifthPromise = manager.answer('K35', fifthCorrectStudent, 'A');
  assert.equal((await manager.answer('K35', sixthCorrectStudent, 'A')).ok, false);
  assert.equal(rewardCalls, 5);
  assert.equal(manager.getPublicState('K35').winners.length, 0);
  releaseReward();
  const [winner, second, third, fourth, fifth] = await Promise.all([
    winnerPromise, concurrentAnswer, thirdPromise, fourthPromise, fifthPromise,
  ]);

  assert.equal(winner.correct, true);
  assert.equal(winner.rank, 1);
  assert.equal(winner.winner.name, 'Bạn Nhanh');
  assert.equal(winner.winner.rank, 1);
  assert.equal(winner.winner.stats.exp, 20);
  assert.equal(winner.winner.stats.xu, 20);
  assert.deepEqual([second, third, fourth, fifth].map((result) => result.winner.rank), [2, 3, 4, 5]);
  assert.deepEqual(manager.getPublicState('K35').winners.map((entry) => entry.rank), [1, 2, 3, 4, 5]);
  assert.equal(manager.next('K35', teacher).state.status, 'finished');
  assert.ok(emitted.some((entry) => entry.event === 'quiz:state'));
});

test('quiz automatically advances after the 30-second answer window', async () => {
  const questions = [
    { question: '一', answers: { A: '1', B: '2', C: '3', D: '4' }, correctAnswer: 'A' },
    { question: '二', answers: { A: '1', B: '2', C: '3', D: '4' }, correctAnswer: 'B' },
  ];
  const manager = createQuizManager({
    to() { return { emit() {} }; },
  }, { grantGameReward: async () => ({ stats: { level: 1, exp: 20, xu: 20 } }) }, {
    roundDurationMs: 25,
  });
  manager.start('K35', { role: 'teacher' }, questions);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(manager.getPublicState('K35').questionNumber, 2);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(manager.getPublicState('K35').status, 'finished');
});

test('persistent quiz state and rankings are shared across manager instances', async () => {
  const sharedState = createMemoryGameStateStore();
  const emitted = [];
  const io = { to: () => ({ emit: (event, state) => emitted.push({ event, state }) }) };
  const rewards = [];
  const auth = {
    async grantGameReward(userId, exp, xu, rewardId) {
      rewards.push({ userId, exp, xu, rewardId });
      return { stats: { level: 1, exp, xu } };
    },
  };
  const options = {
    gameType: 'quiz',
    eventName: 'quiz:state',
    normalize: normalizeQuestions,
    invalidQuestionsMessage: 'invalid',
    oneAttempt: true,
    evaluate: (answer) => ({
      valid: typeof answer === 'string' && /^[A-D]$/i.test(answer),
      error: 'invalid',
      isCorrect: (question) => answer.toUpperCase() === question.correctAnswer,
    }),
    roundDurationMs: 5000,
  };
  const firstInstance = createPersistentGameManager(io, auth, sharedState, options);
  const secondInstance = createPersistentGameManager(io, auth, sharedState, options);
  const questions = [{
    question: '你好 nghĩa là gì?',
    answers: { A: 'Xin chào', B: 'Tạm biệt', C: 'Cảm ơn', D: 'Xin lỗi' },
    correctAnswer: 'A',
  }];

  assert.equal((await firstInstance.start('K35', { role: 'teacher' }, questions)).ok, true);
  assert.equal((await secondInstance.getPublicState('K35')).questionNumber, 1);
  const student = {
    _id: new ObjectId(),
    role: 'student',
    character: { nickname: 'Bạn Nhanh' },
  };
  const answer = await secondInstance.answer('K35', student, 'A');

  assert.equal(answer.correct, true);
  assert.equal(answer.rank, 1);
  assert.equal((await firstInstance.getPublicState('K35')).winners[0].name, 'Bạn Nhanh');
  assert.equal((await firstInstance.getPublicState('K35')).winners[0].rank, 1);
  assert.equal(rewards.length, 1);
  assert.match(rewards[0].rewardId, /^[0-9a-f-]+:0:/);
  assert.ok(emitted.some((entry) => entry.event === 'quiz:state'));
  await firstInstance.end('K35', { role: 'teacher' });
});

test('persistent quiz advances automatically when the shared round expires', async () => {
  const stateStore = createMemoryGameStateStore();
  const manager = createPersistentGameManager({
    to() { return { emit() {} }; },
  }, {
    grantGameReward: async () => ({ stats: { level: 1, exp: 20, xu: 20 } }),
  }, stateStore, {
    gameType: 'quiz',
    eventName: 'quiz:state',
    normalize: normalizeQuestions,
    invalidQuestionsMessage: 'invalid',
    oneAttempt: true,
    evaluate: (answer) => ({
      valid: typeof answer === 'string' && /^[A-D]$/i.test(answer),
      error: 'invalid',
      isCorrect: (question) => answer.toUpperCase() === question.correctAnswer,
    }),
    roundDurationMs: 25,
  });
  const questions = [
    { question: '一', answers: { A: '1', B: '2', C: '3', D: '4' }, correctAnswer: 'A' },
    { question: '二', answers: { A: '1', B: '2', C: '3', D: '4' }, correctAnswer: 'B' },
  ];

  await manager.start('K35', { role: 'teacher' }, questions);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal((await manager.getPublicState('K35')).questionNumber, 2);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal((await manager.getPublicState('K35')).status, 'finished');
});

test('persistent quiz recovers an interrupted reward claim without paying twice', async () => {
  const stateStore = createMemoryGameStateStore();
  const userId = new ObjectId();
  const rewards = [];
  const auth = {
    users: {
      async findOne() {
        return { _id: userId, username: 'student', character: { nickname: 'Học sinh' } };
      },
    },
    async grantGameReward(id, exp, xu, rewardId) {
      rewards.push({ id: id.toString(), exp, xu, rewardId });
      return { stats: { level: 1, exp: 20, xu: 20 } };
    },
  };
  await stateStore.insert('K35', {
    gameType: 'quiz',
    gameId: 'game-recover',
    status: 'active',
    questions: [{
      question: '你好',
      answers: { A: 'Xin chào', B: 'Tạm biệt', C: 'Cảm ơn', D: 'Xin lỗi' },
      correctAnswer: 'A',
    }],
    questionIndex: 0,
    answeredUsers: [userId.toString()],
    claiming: [{
      userId: userId.toString(),
      name: 'Học sinh',
      rank: 1,
      questionIndex: 0,
      createdAt: Date.now() - 61_000,
    }],
    winners: [],
    endsAt: Date.now() + 5000,
  });
  const manager = createPersistentGameManager({ to: () => ({ emit() {} }) }, auth, stateStore, {
    gameType: 'quiz',
    eventName: 'quiz:state',
    normalize: normalizeQuestions,
    invalidQuestionsMessage: 'invalid',
    oneAttempt: true,
    evaluate: (answer) => ({
      valid: typeof answer === 'string' && /^[A-D]$/i.test(answer),
      error: 'invalid',
      isCorrect: (question) => answer.toUpperCase() === question.correctAnswer,
    }),
    roundDurationMs: 5000,
  });

  const state = await manager.getPublicState('K35');
  assert.equal(state.winners[0].rank, 1);
  assert.equal(state.winners[0].name, 'Học sinh');
  assert.equal(rewards.length, 1);
  assert.equal(rewards[0].rewardId, `game-recover:0:${userId}`);
  await manager.end('K35', { role: 'teacher' });
});

test('persistent quiz and Hanzi starts cannot overlap across instances', async () => {
  const stateStore = createMemoryGameStateStore();
  const io = { to: () => ({ emit() {} }) };
  const auth = { grantGameReward: async () => ({ stats: { level: 1, exp: 20, xu: 20 } }) };
  const quiz = createPersistentGameManager(io, auth, stateStore, {
    gameType: 'quiz',
    eventName: 'quiz:state',
    normalize: normalizeQuestions,
    invalidQuestionsMessage: 'invalid',
    oneAttempt: true,
    evaluate: (answer) => ({
      valid: typeof answer === 'string' && /^[A-D]$/i.test(answer),
      error: 'invalid',
      isCorrect: (question) => answer.toUpperCase() === question.correctAnswer,
    }),
    roundDurationMs: 5000,
  });
  const hanzi = createPersistentGameManager(io, auth, stateStore, {
    gameType: 'hanzi',
    eventName: 'hanzi:state',
    normalize: normalizeHanziQuestions,
    invalidQuestionsMessage: 'invalid',
    oneAttempt: false,
    evaluate: (answer) => ({
      valid: Boolean(normalizeMeaning(answer)),
      error: 'invalid',
      isCorrect: (question) => question.meanings.some(
        (meaning) => normalizeMeaning(meaning) === normalizeMeaning(answer),
      ),
    }),
    roundDurationMs: 5000,
  });
  const quizQuestions = [{
    question: '你好',
    answers: { A: 'Xin chào', B: 'Tạm biệt', C: 'Cảm ơn', D: 'Xin lỗi' },
    correctAnswer: 'A',
  }];
  const hanziQuestions = [{ hanzi: '你好', meanings: ['Xin chào'] }];

  const starts = await Promise.all([
    quiz.start('K35', { role: 'teacher' }, quizQuestions),
    hanzi.start('K35', { role: 'teacher' }, hanziQuestions),
  ]);
  assert.equal(starts.filter((result) => result.ok).length, 1);
  assert.equal((await quiz.hasActive('K35')) + (await hanzi.hasActive('K35')), 1);
  if (await quiz.hasActive('K35')) await quiz.end('K35', { role: 'teacher' });
  else await hanzi.end('K35', { role: 'teacher' });
});

test('shop purchases use server prices, enforce balance, and add unique owned items', async () => {
  const db = createMockDatabase();
  const auth = createAuthService(db);
  const user = await auth.createUser('shop_player', 'shop-player-password');
  await auth.saveCharacter(user._id, validCharacter);
  const token = await auth.createSession(user._id);
  await auth.users.updateOne(
    { _id: user._id },
    { $set: { gameStats: { level: 1, exp: 0, xu: 50 } } },
  );
  const app = express();
  app.use(express.json());
  app.use('/api/shop', createShopRouter(auth));
  app.use((error, request, response, next) => {
    response.status(500).json({ error: error.message });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/shop`;
  const headers = { Cookie: `tieu_tieu_session=${token}`, 'Content-Type': 'application/json' };

  try {
    const unauthenticated = await fetch(baseUrl);
    assert.equal(unauthenticated.status, 401);

    const catalogResponse = await fetch(baseUrl, { headers });
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json();
    assert.equal(catalog.balance, 50);
    assert.ok(catalog.items.length >= 10);
    assert.ok(catalog.items.every((item) => item.owned === false));

    const insufficient = await fetch(`${baseUrl}/purchase`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ itemId: 'school-hoodie', price: 1 }),
    });
    assert.equal(insufficient.status, 409);

    await auth.users.updateOne(
      { _id: user._id },
      { $set: { gameStats: { level: 1, exp: 0, xu: 120 } } },
    );
    const purchase = await fetch(`${baseUrl}/purchase`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ itemId: 'school-hoodie', price: 0 }),
    });
    assert.equal(purchase.status, 201);
    const purchased = await purchase.json();
    assert.equal(purchased.balance, 60);
    assert.equal(purchased.item.price, 60);
    assert.equal(purchased.inventory[0].itemId, 'school-hoodie');

    const equip = await fetch(`${baseUrl}/equip`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ itemId: 'school-hoodie' }),
    });
    assert.equal(equip.status, 200);
    assert.deepEqual((await equip.json()).equipped, { top: 'school-hoodie' });

    const unequip = await fetch(`${baseUrl}/equip`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ itemId: 'school-hoodie' }),
    });
    assert.equal(unequip.status, 200);
    assert.deepEqual((await unequip.json()).equipped, {});

    const duplicate = await fetch(`${baseUrl}/purchase`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ itemId: 'school-hoodie' }),
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await auth.getAccountData(user._id)).stats.xu, 60);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('registration, authentication, logout, and admin role management', async () => {
  const app = express();
  const auth = createAuthService(createMockDatabase());
  app.use(express.json());
  app.use('/api/auth', createAuthRouter(auth, { bootstrapToken: 'one-time-test-code' }));
  app.use((error, request, response, next) => {
    response.status(500).json({ error: error.message });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/auth`;

  try {
    const registration = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'student_01',
        password: 'student-password-123',
        role: 'admin',
      }),
    });
    assert.equal(registration.status, 201);
    const student = await registration.json();
    assert.equal(student.user.role, 'student');
    assert.equal(Object.hasOwn(student.user, 'passwordHash'), false);
    const studentCookie = registration.headers.get('set-cookie').split(';', 1)[0];

    const accountResponse = await fetch(`${baseUrl}/account`, {
      headers: { Cookie: studentCookie },
    });
    assert.equal(accountResponse.status, 200);
    assert.deepEqual((await accountResponse.json()).account, {
      stats: { level: 1, exp: 0, xu: 0 },
      inventory: [],
    });

    const meBeforeCharacter = await fetch(`${baseUrl}/me`, {
      headers: { Cookie: studentCookie },
    });
    assert.equal((await meBeforeCharacter.json()).user.character, undefined);

    const savedCharacter = await fetch(`${baseUrl}/character`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
      body: JSON.stringify(validCharacter),
    });
    assert.equal(savedCharacter.status, 200);
    assert.equal((await savedCharacter.json()).user.character.nickname, validCharacter.nickname);

    const meAfterCharacter = await fetch(`${baseUrl}/me`, {
      headers: { Cookie: studentCookie },
    });
    assert.equal((await meAfterCharacter.json()).user.character.nickname, validCharacter.nickname);

    const secondRegistration = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'student_02', password: 'student-password-456' }),
    });
    assert.equal(secondRegistration.status, 201);
    const secondCookie = secondRegistration.headers.get('set-cookie').split(';', 1)[0];

    const secondAccountResponse = await fetch(`${baseUrl}/account`, {
      headers: { Cookie: secondCookie },
    });
    const secondAccount = await secondAccountResponse.json();
    assert.deepEqual(secondAccount.account.inventory, []);
    assert.deepEqual(secondAccount.account.stats, { level: 1, exp: 0, xu: 0 });

    const duplicateCharacter = await fetch(`${baseUrl}/character`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: secondCookie },
      body: JSON.stringify({ ...validCharacter, nickname: 'mÌNH 01' }),
    });
    assert.equal(duplicateCharacter.status, 409);

    const invalidCharacter = await fetch(`${baseUrl}/character`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
      body: JSON.stringify({ ...validCharacter, accessory: 'script' }),
    });
    assert.equal(invalidCharacter.status, 400);

    const forbidden = await fetch(`${baseUrl}/admin/users`, {
      headers: { Cookie: studentCookie },
    });
    assert.equal(forbidden.status, 403);

    const forbiddenTeacherCreation = await fetch(`${baseUrl}/admin/teachers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
      body: JSON.stringify({ username: 'teacher_01', password: 'teacher-password-123' }),
    });
    assert.equal(forbiddenTeacherCreation.status, 403);

    const duplicate = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'STUDENT_01', password: 'student-password-123' }),
    });
    assert.equal(duplicate.status, 409);

    const login = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'STUDENT_01', password: 'student-password-123' }),
    });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).user.role, 'student');

    const bootstrap = await fetch(`${baseUrl}/bootstrap-admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bootstrapToken: 'one-time-test-code',
        username: 'center_admin',
        password: 'center-admin-password',
      }),
    });
    assert.equal(bootstrap.status, 201);
    const admin = await bootstrap.json();
    assert.equal(admin.user.role, 'admin');
    const adminCookie = bootstrap.headers.get('set-cookie').split(';', 1)[0];

    const createTeacher = await fetch(`${baseUrl}/admin/teachers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ username: 'teacher_01', password: 'teacher-password-123' }),
    });
    assert.equal(createTeacher.status, 201);
    assert.deepEqual((await createTeacher.json()).user.role, 'teacher');

    const duplicateTeacher = await fetch(`${baseUrl}/admin/teachers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ username: 'TEACHER_01', password: 'teacher-password-123' }),
    });
    assert.equal(duplicateTeacher.status, 409);

    const usersResponse = await fetch(`${baseUrl}/admin/users`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(usersResponse.status, 200);
    const users = await usersResponse.json();
    const registeredStudent = users.users.find((user) => user.username === 'student_01');
    assert.ok(registeredStudent);

    const promote = await fetch(`${baseUrl}/admin/users/${registeredStudent.id}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ role: 'teacher' }),
    });
    assert.equal(promote.status, 200);
    assert.equal((await promote.json()).user.role, 'teacher');

    const logout = await fetch(`${baseUrl}/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
      body: '{}',
    });
    assert.equal(logout.status, 204);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});


test('shop catalog includes 35+ wearable items and allows equipping owned items onto character', async () => {
  const db = createMockDatabase();
  const auth = createAuthService(db);
  const user = await auth.createUser('fashion_student', 'fashion-password-123');
  const token = await auth.createSession(user._id);
  await auth.saveCharacter(user._id, validateCharacter(validCharacter));
  await auth.users.updateOne(
    { _id: user._id },
    { $set: { gameStats: { level: 2, exp: 20, xu: 500 } } },
  );

  const app = express();
  app.use(express.json());
  app.use('/api/shop', createShopRouter(auth));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/shop`;
  const headers = { Cookie: `tieu_tieu_session=${token}`, 'Content-Type': 'application/json' };

  try {
    const catalog = await (await fetch(baseUrl, { headers })).json();
    assert.ok(catalog.items.length >= 35);
    assert.ok(catalog.items.every((item) => Boolean(item.slot && item.collection)));

    const unownedEquip = await fetch(`${baseUrl}/equip`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ itemId: 'tet-aodai-red' }),
    });
    assert.equal(unownedEquip.status, 403);

    const buyRes = await fetch(`${baseUrl}/purchase`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ itemId: 'tet-aodai-red' }),
    });
    assert.equal(buyRes.status, 201);

    const equipRes = await fetch(`${baseUrl}/equip`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ itemId: 'tet-aodai-red' }),
    });
    assert.equal(equipRes.status, 200);
    const equippedBody = await equipRes.json();
    assert.equal(equippedBody.equipped.outfit, 'tet-aodai-red');

    const unequipRes = await fetch(`${baseUrl}/equip`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ itemId: 'tet-aodai-red' }),
    });
    assert.equal(unequipRes.status, 200);
    const unequippedBody = await unequipRes.json();
    assert.equal(unequippedBody.equipped.outfit, undefined);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
