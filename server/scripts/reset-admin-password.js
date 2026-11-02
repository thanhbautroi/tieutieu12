const path = require('node:path');
const readline = require('node:readline/promises');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');
const { MongoClient } = require('mongodb');
const { createAuthService, validatePassword, validateUsername } = require('../src/auth');

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      reject(new Error('Cần chạy lệnh này trực tiếp trong terminal để nhập mật khẩu an toàn.'));
      return;
    }

    process.stdout.write(prompt);
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();

    let value = '';
    function finish(error) {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    }

    function onData(chunk) {
      for (const character of chunk) {
        if (character === '\u0003') {
          finish(new Error('Đã hủy thao tác.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = Array.from(value).slice(0, -1).join('');
          continue;
        }
        if (character >= ' ') value += character;
      }
    }

    input.on('data', onData);
  });
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Cần chạy lệnh này trực tiếp trong terminal để nhập mật khẩu an toàn.');
  }
  if (!process.env.MONGODB_URI) {
    throw new Error('Thiếu MONGODB_URI trong file .env ở thư mục gốc.');
  }

  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });

  try {
    await client.connect();
    const db = client.db(process.env.DB_NAME || 'tieu_tieu');
    const admin = await db.collection('users').findOne(
      { role: 'admin' },
      { projection: { _id: 1, username: 1, status: 1 } },
    );

    const prompts = readline.createInterface({ input: process.stdin, output: process.stdout });
    let username;
    if (admin) {
      if (admin.status !== 'active') {
        prompts.close();
        throw new Error(`Tài khoản quản trị "${admin.username}" không hoạt động; không thể tự đặt lại mật khẩu.`);
      }
      const confirmation = await prompts.question(
        `Tài khoản quản trị: ${admin.username}\nNhập lại tên tài khoản để xác nhận đặt lại mật khẩu: `,
      );
      if (confirmation !== admin.username) {
        prompts.close();
        throw new Error('Tên tài khoản xác nhận không khớp.');
      }
      username = admin.username;
    } else {
      const requestedUsername = await prompts.question('Chưa có quản trị viên. Tên đăng nhập quản trị mới: ');
      username = validateUsername(requestedUsername);
      if (!username) {
        prompts.close();
        throw new Error('Tên đăng nhập cần dài 3-20 ký tự, chỉ gồm chữ, số hoặc dấu gạch dưới.');
      }
      const confirmation = await prompts.question('Nhập lại tên để xác nhận tạo quản trị viên đầu tiên: ');
      if (confirmation !== username) {
        prompts.close();
        throw new Error('Tên tài khoản xác nhận không khớp.');
      }
    }
    prompts.close();

    const password = await askHidden('Mật khẩu mới (không hiển thị): ');
    if (!validatePassword(password)) {
      throw new Error('Mật khẩu cần dài từ 10 đến 72 byte.');
    }
    const confirmationPassword = await askHidden('Nhập lại mật khẩu mới: ');
    if (password !== confirmationPassword) throw new Error('Hai mật khẩu không khớp.');

    if (!admin) {
      await createAuthService(db).createUser(username, password, 'admin');
      process.stdout.write(`Đã tạo tài khoản quản trị "${username}". Hãy đăng nhập bằng tài khoản mới.\n`);
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await db.collection('users').updateOne(
      { _id: admin._id, role: 'admin', status: 'active' },
      { $set: { passwordHash, updatedAt: new Date() } },
    );
    if (result.matchedCount !== 1) {
      throw new Error('Tài khoản quản trị đã thay đổi; mật khẩu chưa được cập nhật.');
    }

    await db.collection('sessions').deleteMany({ userId: admin._id });
    process.stdout.write(`Đã đặt lại mật khẩu cho tài khoản ${admin.username}; các phiên cũ đã bị đăng xuất.\n`);
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Không thể đặt lại mật khẩu: ${error.message}\n`);
    process.exitCode = 1;
  });
}
