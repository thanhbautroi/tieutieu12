// Tầng lưu trữ của game.
//
// Giai đoạn khung (hiện tại): trạng thái phòng chơi (ai đang ở đâu) giữ trong bộ nhớ,
// vì dữ liệu này thay đổi liên tục và không cần lưu lâu dài.
//
// Khi thành cung cấp MONGODB_URI (chuỗi kết nối MongoDB Atlas), các dữ liệu lâu dài
// (tài khoản, nhân vật, điểm Xu, kho câu hỏi) sẽ được ghi xuống MongoDB qua tầng này.
// Trạng thái real-time của phòng vẫn giữ trong bộ nhớ kể cả khi đã có MongoDB.

const rooms = new Map(); // roomName -> Map(socketId -> player)

function init() {
  if (process.env.MONGODB_URI) {
    console.log('[store] Đã thấy MONGODB_URI — sẽ dùng MongoDB cho dữ liệu lâu dài ở giai đoạn tài khoản.');
  } else {
    console.log('[store] Chưa có MONGODB_URI — chạy chế độ bộ nhớ tạm, đủ cho giai đoạn khung.');
  }
}

function getRoom(name) {
  if (!rooms.has(name)) rooms.set(name, new Map());
  return rooms.get(name);
}

function addPlayer(roomName, player) {
  getRoom(roomName).set(player.id, player);
}

function getPlayer(roomName, id) {
  const room = rooms.get(roomName);
  return room ? room.get(id) : undefined;
}

function updatePosition(roomName, id, x, y) {
  const player = getPlayer(roomName, id);
  if (player) {
    player.x = x;
    player.y = y;
  }
  return player;
}

function updateCharacter(roomName, id, character) {
  const player = getPlayer(roomName, id);
  if (player && character) {
    player.character = character;
    player.name = character.nickname || player.name;
  }
  return player;
}

function removePlayer(roomName, id) {
  const room = rooms.get(roomName);
  if (room) room.delete(id);
}

function playersIn(roomName) {
  const room = rooms.get(roomName);
  return room ? Array.from(room.values()) : [];
}

function roomNames() {
  return Array.from(rooms.keys());
}

module.exports = {
  init,
  addPlayer,
  getPlayer,
  updatePosition,
  updateCharacter,
  removePlayer,
  playersIn,
  roomNames,
};
