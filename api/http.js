const { getApiHandler } = require('../server/src/vercel-runtime');

const handler = getApiHandler();

module.exports = (request, response) => {
  const parsedUrl = new URL(request.url, 'http://localhost');
  const route = parsedUrl.searchParams.get('route');
  if (!route || route.startsWith('/') || route.includes('..')) {
    response.statusCode = 400;
    response.end('Invalid API route');
    return;
  }

  parsedUrl.searchParams.delete('route');
  request.url = `/${route}${parsedUrl.search}`;
  handler(request, response);
};

module.exports.config = { api: { bodyParser: false } };
