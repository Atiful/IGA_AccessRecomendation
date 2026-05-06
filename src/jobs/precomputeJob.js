// src/jobs/precomputeJob.js
const cron = require('node-cron');
const { transaction } = require('../db/pool');
const logger = require('../utils/logger');

async function refreshPrecomputedTable() {
  try {
    logger.info('Starting precompute job...');

    await transaction(async (conn) => {

      // 1. Create new table with same structure
      await conn.query(`
        CREATE TABLE ROLE_ACCESS_SUMMARY_NEW LIKE ROLE_ACCESS_SUMMARY;
      `);

      // 2. Insert computed data into NEW table
await conn.query(`
    INSERT INTO ROLE_ACCESS_SUMMARY_NEW
    (
        role_id,
        manager_id,
        total_people,
        access_type,
        users_with_access,
        risk_level,
        requestable_by
    )
    SELECT 
        r.id AS role_id,
        COALESCE(u.manager_id, 'NO_MANAGER') AS manager_id,

        COUNT(DISTINCT u.id) AS total_people,

        COALESCE(ar.requested_role, 'NO_ACCESS') AS access_type,

        COUNT(DISTINCT CASE 
            WHEN ar.status = 'approved' THEN u.id 
        END) AS users_with_access,

        MAX(ac.risk_level) AS risk_level,
        MAX(ac.requestable_by) AS requestable_by

    FROM USERS u
    JOIN ROLES r ON u.role_id = r.id
    LEFT JOIN ACCESS_REQUESTS ar ON u.id = ar.user_id
    LEFT JOIN ACCESS_CATALOG ac 
        ON ar.requested_role = ac.name

    GROUP BY 
        r.id,
        manager_id,
        access_type;
`);
      



      // 3. Swap tables (atomic)
      await conn.query(`
        RENAME TABLE 
          ROLE_ACCESS_SUMMARY TO ROLE_ACCESS_SUMMARY_OLD,
          ROLE_ACCESS_SUMMARY_NEW TO ROLE_ACCESS_SUMMARY;
      `);

      // 4. Drop old table
      await conn.query(`
        DROP TABLE ROLE_ACCESS_SUMMARY_OLD;
      `);

    });

    logger.info('Precompute table refreshed safely');

  } catch (err) {
    logger.error('Precompute job failed', err);
  }
}

function startPrecomputeJob() {
  // Runs every 5 minutes
  cron.schedule('*/1 * * * *', refreshPrecomputedTable);
  logger.info('Precompute cron job scheduled (every 1 min)');
}

module.exports = { startPrecomputeJob };