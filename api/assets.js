const path = require('path');
const express = require('express');

const app = express();
const socketClientPath = path.resolve(
  path.dirname(require.resolve('socket.io')),
  '..',
  'client-dist',
  'socket.io.min.js',
);
const xlsxDistPath = path.resolve(path.dirname(require.resolve('@e965/xlsx')), 'dist');

app.disable('x-powered-by');
app.get('/socket.io-client.js', (request, response, next) => {
  response.sendFile(socketClientPath, (error) => {
    if (error) next(error);
  });
});
app.use('/vendor/xlsx', express.static(xlsxDistPath));
app.use((request, response) => {
  response.sendStatus(404);
});
app.use((error, request, response, next) => {
  console.error('[assets] Request failed:', error);
  if (response.headersSent) return next(error);
  return response.status(500).send('Asset could not be served.');
});

module.exports = (request, response) => {
  const parsedUrl = new URL(request.url, 'http://localhost');
  const asset = parsedUrl.searchParams.get('asset');
  if (asset === 'socket.io-client.js') {
    request.url = '/socket.io-client.js';
  } else if (asset && asset.startsWith('xlsx/')) {
    request.url = `/vendor/xlsx/${asset.slice('xlsx/'.length)}`;
  } else {
    response.statusCode = 404;
    response.end('Not found');
    return;
  }

  app(request, response);
};
