const fs = require('fs');
const path = require('path');

const socketClientPath = require.resolve('socket.io');
const clientBundle = path.join(path.dirname(socketClientPath), '..', 'client-dist', 'socket.io.min.js');
const outputPath = path.join(__dirname, '..', 'client', 'socket.io-client.js');

fs.copyFileSync(clientBundle, outputPath);
