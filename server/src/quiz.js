const MAX_QUESTIONS = 100;
const MAX_QUESTION_LENGTH = 300;
const MAX_ANSWER_LENGTH = 160;
const MAX_EXPLANATION_LENGTH = 300;
const MAX_WINNERS = 5;
const ROUND_DURATION_MS = 30_000;
const ANSWER_KEYS = ['A', 'B', 'C', 'D'];

function normalizeQuestions(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUESTIONS) {
    return null;
  }

  const questions = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const question = typeof item.question === 'string' ? item.question.trim() : '';
    const correctAnswer = typeof item.correctAnswer === 'string'
      ? item.correctAnswer.trim().toUpperCase()
      : '';
    const explanation = typeof item.explanation === 'string' ? item.explanation.trim() : '';
    if (!question || question.length > MAX_QUESTION_LENGTH
      || !ANSWER_KEYS.includes(correctAnswer)
      || explanation.length > MAX_EXPLANATION_LENGTH
      || !item.answers || typeof item.answers !== 'object' || Array.isArray(item.answers)) {
      return null;
    }

    const answers = {};
    for (const key of ANSWER_KEYS) {
      const answer = typeof item.answers[key] === 'string' ? item.answers[key].trim() : '';
      if (!answer || answer.length > MAX_ANSWER_LENGTH) return null;
      answers[key] = answer;
    }
    questions.push({ question, answers, correctAnswer, explanation });
  }
  return questions;
}

function createQuizManager(io, auth, options = {}) {
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
      question: {
        question: question.question,
        answers: question.answers,
      },
      endsAt: state.endsAt,
      winners: state.winners.map(({ userId, name, rank }) => ({ userId, name, rank })),
    };
  }

  function broadcast(room) {
    io.to(room).emit('quiz:state', getPublicState(room));
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
    state.answeredUsers = new Set();
    state.endsAt = Date.now() + roundDurationMs;
    state.timer = setTimeout(() => advance(room, state), roundDurationMs);
    broadcast(room);
  }

  function start(room, user, rawQuestions, hasOtherGame = false) {
    if (!canManage(user)) return { ok: false, error: 'Chỉ giáo viên mới được khởi động trò chơi.' };
    if (hasOtherGame) return { ok: false, error: 'Đang có một trò chơi khác trong lớp.' };
    if (hasOtherGame) return { ok: false, error: 'Đang có một trò chơi khác trong lớp.' };
    const questions = normalizeQuestions(rawQuestions);
    if (!questions) {
      return {
        ok: false,
        error: `Bộ câu hỏi không hợp lệ. Hãy nhập từ 1 đến ${MAX_QUESTIONS} câu, mỗi câu có đủ 4 đáp án.`,
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
      answeredUsers: new Set(),
      claiming: new Map(),
      winners: [],
      endsAt: Date.now() + roundDurationMs,
      timer: null,
    };
    state.timer = setTimeout(() => advance(room, state), roundDurationMs);
    rooms.set(room, state);
    broadcast(room);
    return { ok: true, state: getPublicState(room) };
  }

  function next(room, user) {
    if (!canManage(user)) return { ok: false, error: 'Chỉ giáo viên mới được điều khiển trò chơi.' };
    const state = rooms.get(room);
    if (!state || state.status !== 'active') return { ok: false, error: 'Hiện không có trò chơi đang diễn ra.' };
    if (state.claiming.size > 0) return { ok: false, error: 'Đang xác nhận người nhận thưởng, vui lòng đợi.' };
    advance(room, state);
    return { ok: true, state: getPublicState(room) };
  }

  function end(room, user) {
    if (!canManage(user)) return { ok: false, error: 'Chỉ giáo viên mới được điều khiển trò chơi.' };
    const state = rooms.get(room);
    if (!state || state.status !== 'active') return { ok: false, error: 'Hiện không có trò chơi đang diễn ra.' };
    if (state.claiming.size > 0) return { ok: false, error: 'Đang xác nhận người nhận thưởng, vui lòng đợi.' };
    clearTimeout(state.timer);
    state.status = 'finished';
    broadcast(room);
    return { ok: true, state: getPublicState(room) };
  }

  async function answer(room, user, answerKey) {
    if (!user || user.role !== 'student') {
      return { ok: false, error: 'Chỉ học sinh mới được trả lời câu hỏi.' };
    }
    const state = rooms.get(room);
    if (!state || state.status !== 'active') return { ok: false, error: 'Hiện không có câu hỏi đang mở.' };
    if (Date.now() >= state.endsAt) {
      advance(room, state);
      return { ok: false, error: 'Hết thời gian trả lời câu này.' };
    }
    const userId = user._id.toString();
    if (state.answeredUsers.has(userId)) {
      return { ok: false, error: 'Bạn đã trả lời câu hỏi này rồi.' };
    }
    if (typeof answerKey !== 'string' || !ANSWER_KEYS.includes(answerKey.toUpperCase())) {
      return { ok: false, error: 'Đáp án không hợp lệ.' };
    }
    if (state.winners.length + state.claiming.size >= MAX_WINNERS) {
      return { ok: false, error: 'Đã đủ 5 người nhận thưởng câu này.' };
    }

    state.answeredUsers.add(userId);
    const question = state.questions[state.questionIndex];
    if (answerKey.toUpperCase() !== question.correctAnswer) {
      return { ok: true, correct: false };
    }

    const rank = state.winners.length + state.claiming.size + 1;
    const questionIndex = state.questionIndex;
    const claiming = state.claiming;
    claiming.set(userId, rank);
    try {
      const reward = await auth.grantGameReward(user._id, 20, 20);
      if (!reward) throw new Error('Không tìm thấy tài khoản nhận thưởng.');
      claiming.delete(userId);
      const winner = {
        userId,
        name: user.character.nickname,
        rank,
        explanation: question.explanation,
        stats: reward.stats,
      };
      if (state.status === 'active' && state.questionIndex === questionIndex) {
        state.winners.push(winner);
        state.winners.sort((a, b) => a.rank - b.rank);
        broadcast(room);
      }
      return { ok: true, correct: true, rank, winner };
    } catch (error) {
      claiming.delete(userId);
      state.answeredUsers.delete(userId);
      throw error;
    }
  }

  return {
    answer,
    end,
    getPublicState,
    next,
    start,
  };
}

module.exports = { createQuizManager, normalizeQuestions };
