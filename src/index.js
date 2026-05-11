require('dotenv').config({ path: '../.env' });
const express = require('express');
const app = express();
const logger = require('./utils/logger');
const { startPrecomputeJob } = require('./jobs/precomputeJob');

const PORT = process.env.PORT || 3000; 


async function boot() {
  logger.info('=== NextGen IGA — Access Recommendation Engine ===');
    
  // database update or recreate the recomputed table (role name , manager_name , total_people , access_type , access_user)


  // . Start HTTP server
  const server = app.listen(PORT, () => {
    logger.info(`Server listening on http://localhost:${PORT}`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info('API ready — see README.md for endpoint documentation');
  });

  // precomputed job 
  startPrecomputeJob();

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info(`${signal} received — shutting down gracefully...`);
    server.close(async () => {
      const { getPool } = require('./db/pool');
      try { await getPool().end(); } catch (_) {}
      logger.info('Server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000);
  };
   
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

boot().catch((err) => {
  console.error('Fatal boot error:', err);
  process.exit(1);
});


module.exports = {app};



