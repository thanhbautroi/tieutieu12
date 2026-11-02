const MAX_QUESTIONS = 100;
const MAX_HANZI_LENGTH = 80;
const MAX_MEANING_LENGTH = 160;
const MAX_WINNERS = 5;
const ROUND_DURATION_MS = 30_000;

function normalizeMeaning(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeHanziQuestions(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUESTIONS) return null;

  const questions = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const hanzi = typeof item.hanzi === 'string' ? item.hanzi.trim() : '';
    const rawMeanings = Array.isArray(item.meanings)
      ? item.meanings
      : typeof item.meaning === 'string' ? item.meaning.split(/[|;/]/) : [];
    const meanings = [...new Set(rawMeanings
      .filter((meaning) => typeof meaning === 'string')
      .map((meaning) => meaning.trim())
      .filter(Boolean))];
    if (!hanzi || hanzi.length > MAX_HANZI_LENGTH || meanings.length === 0
      || meanings.length > 10
      || meanings.some((meaning) => meaning.length > MAX_MEANING_LENGTH
        || !normalizeMeaning(meaning))) {
      return null;
    }
    questions.push({ hanzi, meanings });
  }
  return questions;
}

function createHanziGameManager(io, auth, options = {}) {
  const rooms = new Map();
  const roundDurationMs = options.roundDurationMs || ROUND_DURATION_MS;
  const canManage = (user) => user && ['teacher', 'admin'].includes(user.role);

  function getPublicState(room) {
    const state = rooms.get(room);
    if (!state) return { status: 'idle' };
    if (state.status === 'finished') {
      return {
        status: 'finished',
        questionCount: state.questions.length,
        winners: state.winners.map(({ userId, name, rank }) => ({ userId, name, rank })),
      };
    }
    const question = state.questions[state.questionIndex];
    return {
      status: 'active',
      questionNumber: state.questionIndex + 1,
      questionCount: state.questions.length,
      hanzi: question.hanzi,
      endsAt: state.endsAt,
      winners: state.winners.map(({ userId, name, rank }) => ({ userId, name, rank })),
    };
  }

  function broadcast(room) {
    io.to(room).emit('hanzi:state', getPublicState(room));
  }

  function advance(room, expectedState) {
    const state = rooms.get(room);
    if (state !== expectedState || state.status !== 'active') return;
    clearTimeout(state.timer);
    state.questionIndex += 1;
    if (state.questionIndex >= state.questions.length) {
      state.status = 'finished';
      broadcast(room);
      return;
    }
    state.winners = [];
    state.claiming = new Map();
    state.endsAt = Date.now() + roundDurationMs;
    state.timer = setTimeout(() => advance(room, state), roundDurationMs);
    broadcast(room);
  }

  function start(room, user, rawQuestions, hasOtherGame = false) {
    if (!canManage(user)) return { ok: false, error: 'Chỉ giáo viên mới được khởi động trò chơi.' };
    if (hasOtherGame) return { ok: false, error: 'Đang có một trò chơi khác trong lớp.' };
    const questions = normalizeHanziQuestions(rawQuestions);
    if (!questions) {
      return {
        ok: false,
        error: `Bộ câu hỏi không hợp lệ. Hãy nhập từ 1 đến ${MAX_QUESTIONS} dòng gồm chữ Hán và nghĩa tiếng Việt.`,
      };
    }
    const existing = rooms.get(room);
    if (existing && existing.status === 'active') {
      return { ok: false, error: 'Đang có một trò chơi trong lớp. Hãy kết thúc trước khi bắt đầu trò mới.' };
    }

    const state = {
      status: 'active',
      questions,
      questionIndex: 0,
      endsAt: Date.now() + roundDurationMs,
      winners: [],
      claiming: new Map(),
      timer: null,
    };
    state.timer = setTimeout(() => advance(room, state), roundDurationMs);
    rooms.set(room, state);
    broadcast(room);
    return { ok: true, state: getPublicState(room) };
  }

  async function answer(room, user, rawAnswer) {
    if (!user || user.role !== 'student') {
      return { ok: false, error: 'Chỉ học sinh mới được trả lời câu hỏi.' };
    }
    const state = rooms.get(room);
    if (!state || state.status !== 'active') return { ok: false, error: 'Hiện không có câu hỏi nào đang mở.' };
    if (Date.now() >= state.endsAt) {
      advance(room, state);
      return { ok: false, error: 'Hết thời gian trả lời câu này.' };
    }
    const userId = user._id.toString();
    if (state.winners.some((winner) => winner.userId === userId) || state.claiming.has(userId)) {
      return { ok: false, error: 'Bạn đã trả lời đúng câu này rồi.' };
    }
    if (state.winners.length + state.claiming.size >= MAX_WINNERS) {
      return { ok: false, error: 'Đã đủ 5 người nhận thưởng câu này.' };
    }

    const answerText = normalizeMeaning(rawAnswer);
    if (!answerText) return { ok: false, error: 'Hãy nhập nghĩa tiếng Việt vào khung chat.' };
    const question = state.questions[state.questionIndex];
    const acceptedMeanings = question.meanings.map(normalizeMeaning);
    if (!acceptedMeanings.includes(answerText)) return { ok: true, correct: false };

    const rank = state.winners.length + state.claiming.size + 1;
    const questionIndex = state.questionIndex;
    const claiming = state.claiming;
    claiming.set(userId, rank);
    try {
      const reward = await auth.grantGameReward(user._id, 20, 20);
      if (!reward) throw new Error('Không tìm thấy tài khoản nhận thưởng.');
      claiming.delete(userId);
      if (state.status === 'active' && state.questionIndex === questionIndex) {
        state.winners.push({ userId, name: user.character.nickname, rank });
        state.winners.sort((a, b) => a.rank - b.rank);
        broadcast(room);
      }
      return { ok: true, correct: true, rank, stats: reward.stats };
    } catch (error) {
      claiming.delete(userId);
      throw error;
    }
  }

  function end(room, user) {
    if (!canManage(user)) return { ok: false, error: 'Chỉ giáo viên mới được điều khiển trò chơi.' };
    const state = rooms.get(room);
    if (!state || state.status !== 'active') return { ok: false, error: 'Hiện không có trò chơi đang diễn ra.' };
    clearTimeout(state.timer);
    state.status = 'finished';
    broadcast(room);
    return { ok: true, state: getPublicState(room) };
  }

  function hasActive(room) {
    const state = rooms.get(room);
    return Boolean(state && state.status === 'active');
  }

  return { answer, end, getPublicState, hasActive, start };
}

module.exports = {
  createHanziGameManager,
  normalizeHanziQuestions,
  normalizeMeaning,
};
