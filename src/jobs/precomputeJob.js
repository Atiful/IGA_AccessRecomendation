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

//       await conn.query(`
//    INSERT INTO ROLE_ACCESS_SUMMARY_NEW
// (
//     role_id,
//     manager_id,
//     access_type,
//     total_people,
//     users_with_access,
//     risk_level,
//     requestable_by
// )

// SELECT

//     rm.role_id,

//     rm.manager_id,

//     ac.name AS access_type,

//     rm.total_people,

//     COUNT(DISTINCT ua.user_id) AS users_with_access,

//     ac.risk_level,
//     ac.requestable_by

// FROM
// (
//     -- all role + manager combinations
//     SELECT
//         role_id,
//         COALESCE(manager_id, 'NO_MANAGER') AS manager_id,
//         COUNT(*) AS total_people
//     FROM USERS
//     GROUP BY role_id, manager_id
// ) rm

// CROSS JOIN ACCESS_CATALOG ac

// LEFT JOIN USERS u
//     ON u.role_id = rm.role_id
//    AND COALESCE(u.manager_id, 'NO_MANAGER') = rm.manager_id

// LEFT JOIN USER_ACCESS ua
//     ON ua.user_id = u.id
//    AND ua.access_type = ac.name
//    AND ua.status = 'active'

// GROUP BY
//     rm.role_id,
//     rm.manager_id,
//     ac.name,
//     rm.total_people,
//     ac.risk_level,
//     ac.requestable_by;
// `);

      // 2. Insert computed data into NEW table
// await conn.query(`
//    INSERT INTO ROLE_ACCESS_SUMMARY_NEW
// (
//     role_id,
//     manager_id,
//     access_type,
//     total_people,
//     users_with_access,
//     risk_level
// )

// SELECT

//     rm.role_id,

//     rm.manager_id,

//     ac.access_name AS access_type,

//     rm.total_people,

//     COUNT(DISTINCT ua.user_id) AS users_with_access,

//     ac.risk_level

// FROM
// (
//     -- all role + manager combinations
//     SELECT
//         role_id,
//         COALESCE(manager_id, 'NO_MANAGER') AS manager_id,
//         COUNT(*) AS total_people
//     FROM users
//     GROUP BY role_id, manager_id
// ) rm

// CROSS JOIN access_catalog ac

// LEFT JOIN users u
//     ON u.role_id = rm.role_id
//    AND COALESCE(u.manager_id, 'NO_MANAGER') = rm.manager_id

// LEFT JOIN user_access ua
//     ON ua.user_id = u.id
//    AND ua.application_id = ac.access_name
//    AND LOWER(ua.status) = 'active'

// GROUP BY
//     rm.role_id,
//     rm.manager_id,
//     ac.access_name,
//     rm.total_people,
//     ac.risk_level;
// `);


await conn.query(`
INSERT INTO ROLE_ACCESS_SUMMARY_NEW
(
    role_id,
    manager_id,
    access_type,
    total_people,
    users_with_access,
    risk_level
)

SELECT

    rm.role_id,

    rm.manager_id,

    ac.id AS access_type,

    rm.total_people,

    COUNT(DISTINCT ua.user_id) AS users_with_access,

    ac.risk_level

FROM
(
    -- all role + manager combinations
    SELECT
        role_id,
        COALESCE(manager_id, 'NO_MANAGER') AS manager_id,
        COUNT(*) AS total_people
    FROM users
    GROUP BY role_id, manager_id
) rm

CROSS JOIN applications ac

LEFT JOIN users u
    ON u.role_id = rm.role_id
   AND COALESCE(u.manager_id, 'NO_MANAGER') = rm.manager_id

LEFT JOIN user_access ua
    ON ua.user_id = u.id
   AND ua.application_id = ac.id
   AND LOWER(ua.status) = 'active'

GROUP BY
    rm.role_id,
    rm.manager_id,
    ac.id,
    rm.total_people,
    ac.risk_level;
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
  //  cron.schedule('0 0 * * *', refreshPrecomputedTable); // 24hr
  logger.info('Precompute cron job scheduled (every 1 min)');
}

module.exports = { startPrecomputeJob };