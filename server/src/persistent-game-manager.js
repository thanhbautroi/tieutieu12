const crypto = require('crypto');
const { ObjectId } = require('mongodb');

const MAX_WINNERS = 5;
const ROUND_DURATION_MS = 30_000;
const CAS_RETRIES = 12;

function createPersistentGameManager(io, auth, stateStore, options) {
  const timers = new Map();
  const roundDurationMs = options.roundDurationMs || ROUND_DURATION_MS;
  const canManage = (user) => user && ['teacher', 'admin'].includes(user.role);

  function toPublicState(state) {
    if (!state || state.gameType !== options.gameType) return { status: 'idle' };
    const winners = state.winners.map(({ userId, name, rank }) => ({ userId, name, rank }));
    if (state.status === 'finished') {
      return { status: 'finished', questionCount: state.questions.length, winners };
    }

    const question = state.questions[state.questionIndex];
    return {
      status: 'active',
      questionNumber: state.questionIndex + 1,
      questionCount: state.questions.length,
      ...(options.gameType === 'quiz'
        ? { question: { question: question.question, answers: question.answers } }
        : { hanzi: question.hanzi }),
      endsAt: state.endsAt,
      winners,
    };
  }

  async function publish(room) {
    const record = await stateStore.read(room);
    io.to(room).emit(options.eventName, toPublicState(record && record.state));
  }

  function schedule(room, state) {
    const currentTimer = timers.get(room);
    if (currentTimer) clearTimeout(currentTimer);
    timers.delete(room);
    if (!state || state.gameType !== options.gameType || state.status !== 'active') return;

    const delay = state.claiming && state.claiming.length > 0
      ? 500
      : Math.max(1, state.endsAt - Date.now());
    const timer = setTimeout(() => {
      timers.delete(room);
      advanceExpired(room).catch((error) => {
        console.error(`[${options.gameType}] Không thể tự chuyển câu:`, error);
      });
    }, delay);
    timer.unref?.();
    timers.set(room, timer);
  }

  async function mutate(room, transform) {
    for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
      const record = await stateStore.read(room);
      const current = record ? structuredClone(record.state) : null;
      const change = transform(current);
      if (!change.changed) {
        return { changed: false, state: current, value: change.value };
      }

      const saved = record
        ? await stateStore.compareAndSet(room, record.version, change.state)
        : await stateStore.insert(room, change.state);
      if (saved) return { changed: true, state: change.state, value: change.value };
    }
    throw new Error('Không thể cập nhật trạng thái game do có quá nhiều cập nhật đồng thời.');
  }

  async function advance(room, requireExpired) {
    const result = await mutate(room, (state) => {
      if (!state || state.gameType !== options.gameType || state.status !== 'active') {
        return { changed: false, value: { ok: false, error: 'Hiện không có trò chơi đang diễn ra.' } };
      }
      if (requireExpired && Date.now() < state.endsAt) {
        return { changed: false, value: { ok: false, error: 'Câu hỏi chưa hết thời gian.' } };
      }
      if (state.claiming.length > 0) {
        return {
          changed: false,
          value: {
            ok: false,
            error: 'Đang xác nhận người nhận thưởng, vui lòng đợi.',
            pendingRewards: true,
          },
        };
      }

      state.questionIndex += 1;
      if (state.questionIndex >= state.questions.length) {
        state.status = 'finished';
        state.finishedAt = Date.now();
      } else {
        state.winners = [];
        state.answeredUsers = [];
        state.endsAt = Date.now() + roundDurationMs;
      }
      return { changed: true, state, value: { ok: true } };
    });

    if (result.changed) {
      schedule(room, result.state);
      await publish(room);
    } else if (result.value.pendingRewards) {
      schedule(room, { gameType: options.gameType, status: 'active', endsAt: Date.now() + 500 });
    }
    return result;
  }

  async function advanceExpired(room) {
    await recoverStaleClaims(room);
    const result = await advance(room, true);
    return result.changed;
  }

  async function recoverStaleClaims(room) {
    if (!auth.users) return;
    const record = await stateStore.read(room);
    const state = record && record.state;
    if (!state || state.gameType !== options.gameType || state.status !== 'active') return;
    const staleClaims = state.claiming.filter((claim) => Date.now() - claim.createdAt >= 60_000);
    for (const claim of staleClaims) {
      try {
        const userId = ObjectId.isValid(claim.userId) ? new ObjectId(claim.userId) : null;
        const user = userId && await auth.users.findOne({ _id: userId, status: 'active' });
        if (!user) {
          await releaseClaim(room, state.gameId, claim);
          continue;
        }
        const reward = await auth.grantGameReward(
          user._id,
          20,
          20,
          `${state.gameId}:${claim.questionIndex}:${claim.userId}`,
        );
        if (!reward) {
          await releaseClaim(room, state.gameId, claim);
          continue;
        }
        const recovered = await mutate(room, (current) => {
          if (!current || current.gameId !== state.gameId
            || current.questionIndex !== claim.questionIndex
            || !current.claiming.some((entry) => entry.userId === claim.userId)) {
            return { changed: false, value: false };
          }
          current.claiming = current.claiming.filter((entry) => entry.userId !== claim.userId);
          current.winners.push({
            userId: claim.userId,
            name: claim.name || (user.character && user.character.nickname) || user.username,
            rank: claim.rank,
          });
          current.winners.sort((left, right) => left.rank - right.rank);
          return { changed: true, state: current, value: true };
        });
        if (recovered.changed) {
          schedule(room, recovered.state);
          await publish(room);
        }
      } catch (error) {
        console.error(`[${options.gameType}] Không thể khôi phục phần thưởng đang chờ:`, error);
      }
    }
  }

  async function releaseClaim(room, gameId, claim) {
    const released = await mutate(room, (state) => {
      if (!state || state.gameId !== gameId
        || !state.claiming.some((entry) => entry.userId === claim.userId)) {
        return { changed: false, value: false };
      }
      state.claiming = state.claiming.filter((entry) => entry.userId !== claim.userId);
      if (options.oneAttempt) {
        state.answeredUsers = state.answeredUsers.filter((entry) => entry !== claim.userId);
      }
      return { changed: true, state, value: true };
    });
    if (released.changed) {
      schedule(room, released.state);
      await publish(room);
    }
  }

  async function getPublicState(room) {
    await advanceExpired(room);
    const record = await stateStore.read(room);
    const state = record && record.state;
    schedule(room, state);
    return toPublicState(state);
  }

  async function hasActive(room) {
    await advanceExpired(room);
    const record = await stateStore.read(room);
    return Boolean(record
      && record.state.gameType === options.gameType
      && record.state.status === 'active');
  }

  async function start(room, user, rawQuestions, hasOtherGame = false) {
    if (!canManage(user)) return { ok: false, error: 'Chỉ giáo viên mới được khởi động trò chơi.' };
    if (hasOtherGame) return { ok: false, error: 'Đang có một trò chơi khác trong lớp.' };
    const questions = options.normalize(rawQuestions);
    if (!questions) {
      return { ok: false, error: options.invalidQuestionsMessage };
    }

    const state = {
      gameType: options.gameType,
      gameId: crypto.randomUUID(),
      status: 'active',
      questions,
      questionIndex: 0,
      answeredUsers: [],
      claiming: [],
      winners: [],
      endsAt: Date.now() + roundDurationMs,
    };

    const result = await mutate(room, (current) => {
      if (current && current.status === 'active') {
        return { changed: false, value: { ok: false, error: 'Đang có một trò chơi trong lớp. Hãy kết thúc trước khi bắt đầu trò mới.' } };
      }
      return { changed: true, state, value: { ok: true } };
    });
    if (!result.changed) return result.value;
    schedule(room, state);
    await publish(room);
    return { ok: true, state: toPublicState(state) };
  }

  async function end(room, user) {
    if (!canManage(user)) return { ok: false, error: 'Chỉ giáo viên mới được điều khiển trò chơi.' };
    const result = await mutate(room, (state) => {
      if (!state || state.gameType !== options.gameType || state.status !== 'active') {
        return { changed: false, value: { ok: false, error: 'Hiện không có trò chơi đang diễn ra.' } };
      }
      if (state.claiming.length > 0) {
        return { changed: false, value: { ok: false, error: 'Đang xác nhận người nhận thưởng, vui lòng đợi.' } };
      }
      state.status = 'finished';
      state.finishedAt = Date.now();
      return { changed: true, state, value: { ok: true } };
    });
    if (!result.changed) return result.value;
    schedule(room, result.state);
    await publish(room);
    return { ok: true, state: toPublicState(result.state) };
  }

  async function next(room, user) {
    if (!canManage(user)) return { ok: false, error: 'Chỉ giáo viên mới được điều khiển trò chơi.' };
    const result = await advance(room, false);
    if (!result.changed) return result.value;
    return { ok: true, state: toPublicState(result.state) };
  }

  async function answer(room, user, rawAnswer) {
    if (!user || user.role !== 'student') {
      return { ok: false, error: 'Chỉ học sinh mới được trả lời câu hỏi.' };
    }

    const userId = user._id.toString();
    const check = options.evaluate(rawAnswer);
    if (!check.valid) return { ok: false, error: check.error };

    const claimResult = await mutate(room, (state) => {
      if (!state || state.gameType !== options.gameType || state.status !== 'active') {
        return { changed: false, value: { ok: false, error: 'Hiện không có câu hỏi nào đang mở.' } };
      }
      if (Date.now() >= state.endsAt) {
        return { changed: false, value: { expired: true } };
      }
      if (state.winners.some((winner) => winner.userId === userId)
        || state.claiming.some((claim) => claim.userId === userId)) {
        return { changed: false, value: { ok: false, error: 'Bạn đã trả lời đúng câu này rồi.' } };
      }
      if (options.oneAttempt && state.answeredUsers.includes(userId)) {
        return { changed: false, value: { ok: false, error: 'Bạn đã trả lời câu hỏi này rồi.' } };
      }

      const question = state.questions[state.questionIndex];
      const isCorrect = check.isCorrect(question);
      if (!isCorrect) {
        if (!options.oneAttempt) {
          return { changed: false, value: { ok: true, correct: false } };
        }
        state.answeredUsers.push(userId);
        return { changed: true, state, value: { ok: true, correct: false } };
      }
      if (state.winners.length + state.claiming.length >= MAX_WINNERS) {
        return { changed: false, value: { ok: false, error: 'Đã đủ 5 người nhận thưởng câu này.' } };
      }

      if (options.oneAttempt) state.answeredUsers.push(userId);
      const rank = state.winners.length + state.claiming.length + 1;
      const claim = {
        userId,
        name: user.character.nickname,
        rank,
        questionIndex: state.questionIndex,
        createdAt: Date.now(),
      };
      state.claiming.push(claim);
      return {
        changed: true,
        state,
        value: { claimed: true, claim, question: structuredClone(question), gameId: state.gameId },
      };
    });

    if (claimResult.value.expired) {
      await advanceExpired(room);
      return { ok: false, error: 'Hết thời gian trả lời câu này.' };
    }
    if (!claimResult.value.claimed) return claimResult.value;

    const { claim, question, gameId } = claimResult.value;
    try {
      const reward = await auth.grantGameReward(
        user._id,
        20,
        20,
        `${gameId}:${claim.questionIndex}:${userId}`,
      );
      if (!reward) throw new Error('Không tìm thấy tài khoản nhận thưởng.');

      const completed = await mutate(room, (state) => {
        if (!state || state.gameId !== gameId || state.questionIndex !== claim.questionIndex) {
          return { changed: false, value: null };
        }
        if (!state.claiming.some((entry) => entry.userId === userId)) {
          return { changed: false, value: null };
        }
        state.claiming = state.claiming.filter((entry) => entry.userId !== userId);
        state.winners.push({
          userId,
          name: user.character.nickname,
          rank: claim.rank,
          ...(options.gameType === 'quiz' ? { explanation: question.explanation } : {}),
        });
        state.winners.sort((a, b) => a.rank - b.rank);
        return { changed: true, state, value: true };
      });
      if (completed.changed) {
        schedule(room, completed.state);
        await publish(room);
      }
      return {
        ok: true,
        correct: true,
        rank: claim.rank,
        ...(options.gameType === 'quiz'
          ? { winner: { name: user.character.nickname, rank: claim.rank, stats: reward.stats } }
          : { stats: reward.stats }),
      };
    } catch (error) {
      const released = await mutate(room, (state) => {
        if (!state || state.gameId !== gameId || state.questionIndex !== claim.questionIndex) {
          return { changed: false, value: false };
        }
        state.claiming = state.claiming.filter((entry) => entry.userId !== userId);
        if (options.oneAttempt) {
          state.answeredUsers = state.answeredUsers.filter((entry) => entry !== userId);
        }
        return { changed: true, state, value: true };
      });
      if (released.changed) {
        schedule(room, released.state);
        await publish(room);
      }
      throw error;
    }
  }

  return { answer, end, getPublicState, hasActive, next, refresh: advanceExpired, start };
}

module.exports = { createPersistentGameManager };
