const { getApiHandler } = require('../server/src/vercel-runtime');

module.exports = getApiHandler();
module.exports.config = { api: { bodyParser: false } };
