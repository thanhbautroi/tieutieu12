// Mô phỏng 3 "máy điện thoại" cùng vào phòng K35:
// kiểm tra thấy nhau vào phòng, đồng bộ di chuyển và chat.
// Chạy: trước hết bật server (npm start), rồi npm run test:simulate

const { io } = require('socket.io-client');

const URL = process.env.TEST_URL || 'http://localhost:3001';
const results = [];
function check(label, ok) {
  results.push({ label, ok });
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + label);
}

async function createAccount(name) {
  const username = `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const response = await fetch(`${URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'simulate-pass-123' }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Đăng ký mô phỏng thất bại (${response.status}).`);
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error('Server không trả cookie đăng nhập cho tài khoản mô phỏng.');
  const sessionCookie = cookie.split(';', 1)[0];
  const characterResponse = await fetch(`${URL}/api/auth/character`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      nickname: username.slice(0, 16),
      gender: 'male',
      hairStyle: 'short',
      faceStyle: 'A',
      hairColor: 'black',
      shirtStyle: 'shirt',
      shirtColor: 'blue',
      pantsColor: 'gray',
      shoesStyle: 'sneakers',
      backpack: 'brown',
      accessory: 'none',
    }),
  });
  if (!characterResponse.ok) {
    const characterResult = await characterResponse.json();
    throw new Error(characterResult.error || 'Tạo nhân vật mô phỏng thất bại.');
  }
  return { username, cookie: sessionCookie };
}

function connectClient(name, cookie) {
  return new Promise((resolve) => {
    const socket = io(URL, {
      transports: ['websocket'],
      extraHeaders: { Cookie: cookie },
    });
    const client = { name, socket, playersAtJoin: [], seen: { joined: [], moved: [], chat: [] } };
    socket.on('playerJoined', (p) => client.seen.joined.push(p));
    socket.on('playerMoved', (m) => client.seen.moved.push(m));
    socket.on('chat', (c) => client.seen.chat.push(c));
    socket.on('joined', ({ players }) => {
      client.playersAtJoin = players;
      resolve(client);
    });
    socket.on('connect_error', (error) => resolve({ error }));
    socket.emit('join', { name, room: 'K35' });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const clients = [];
  try {
    const [accountA, accountB, accountC] = await Promise.all([
      createAccount('may1'),
      createAccount('may2'),
      createAccount('may3'),
    ]);
    const a = await connectClient(accountA.username, accountA.cookie);
    const b = await connectClient(accountB.username, accountB.cookie);
    const c = await connectClient(accountC.username, accountC.cookie);
    clients.push(a, b, c);
    if (a.error || b.error || c.error) {
      throw new Error((a.error || b.error || c.error).message);
    }
    await wait(300);

    check('Máy 2 thấy Máy 3 vào phòng', b.seen.joined.some((p) => p.name === accountC.username));
    check('Máy 3 thấy đủ 2 người trước trong phòng', c.playersAtJoin.length === 3);

    a.socket.emit('move', { x: 500, y: 300 });
    await wait(300);
    check('Máy 2 nhận được vị trí mới của Máy 1', b.seen.moved.some((m) => m.x === 500 && m.y === 300));

    c.socket.emit('chat', { text: '老师好!' });
    await wait(300);
    check('Máy 1 nhận được chat của Máy 3', a.seen.chat.some((m) => m.text === '老师好!'));
  } catch (err) {
    check('Chạy mô phỏng không lỗi: ' + err.message, false);
  } finally {
    for (const client of clients) {
      if (client.socket) client.socket.disconnect();
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(failed === 0 ? '\nTất cả kiểm tra đều PASS' : `\nCó ${failed} kiểm tra FAIL`);
  process.exit(failed === 0 ? 0 : 1);
})();
