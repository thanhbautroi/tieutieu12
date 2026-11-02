const http = require('http');
const { Server } = require('socket.io');
const { initializeSocketServer } = require('../server/src/vercel-runtime');

const server = http.createServer((request, response) => {
  response.statusCode = 404;
  response.end('Not found');
});
const io = new Server(server, {
  path: '/api/socket-io',
  addTrailingSlash: false,
  transports: ['websocket'],
  maxHttpBufferSize: 16_384,
});

initializeSocketServer(io).catch((error) => {
  console.error('[vercel] Socket.IO initialization failed:', error);
});

module.exports = server;
