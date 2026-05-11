// src/db/pool.js
require('dotenv').config({ path: '../../.env' });
const mysql = require('mysql2/promise');
const logger = require('../utils/logger');

let pool;

    console.log(process.env.DB_HOST);

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || '',
      waitForConnections: true,
      connectionLimit: 20,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      timezone: 'Z',
    });

    logger.info('MySQL connection pool created');
  }
  return pool;
}

async function query(sql, params = []) {
  const conn = getPool();
  const [rows] = await conn.execute(sql, params);
  return rows;
}

async function transaction(fn) {
  const connection = await getPool().getConnection();
  await connection.beginTransaction();
  try {
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

async function checkConnection(){
    const [res] = await query("Select * from USERS");
    console.log(res);
}



module.exports = { getPool, query, transaction };
