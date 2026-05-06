// src/middleware/errorHandler.js
const logger = require('../utils/logger');

function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  const code = err.code || 'INTERNAL_ERROR';

  if (status >= 500) {
    logger.error(`[${req.method} ${req.path}] ${err.message}`, { stack: err.stack });
  } else {
    logger.warn(`[${req.method} ${req.path}] ${code}: ${err.message}`);
  }

  res.status(status).json({
    success: false,
    error: code,
    message: status >= 500 ? 'Internal server error' : err.message,
    ...(process.env.NODE_ENV !== 'production' && status >= 500 ? { stack: err.stack } : {}),
  });
}

function notFound(req, res , error) {
  logger.error(error);
  res.status(404).json({ success: false, error: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` });
}

module.exports = { errorHandler, notFound };
