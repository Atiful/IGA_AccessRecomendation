const { query } = require('../db/pool');
const logger = require('../utils/logger');
const { getRiskScore } = require('./riskScore');

// ─── Single user fetch (used by single route) ─────────────────
async function getUserForRecommendation(userId) {
  const rows = await query(`
    SELECT u.id, u.role_id, u.manager_id, r.role_type, r.role_name
    FROM users_access u
    LEFT JOIN roles r ON r.id = u.role_id
    WHERE u.id = ? AND LOWER(u.status) = 'active'
  `, [userId]);

  if (!rows || rows.length === 0) {
    throw Object.assign(
      new Error(`User ${userId} not found or inactive`),
      { code: 'USER_NOT_FOUND', status: 404 }
    );
  }
  return rows[0];
}

// ─── Single access details fetch (used by single route) ───────
async function getAccessDetails(role_id, manager_id, accessType) {
  const sqlQuery = `
    SELECT 
      SUM(CASE WHEN role_id = ? AND manager_id <=> ? THEN total_people ELSE 0 END) AS same_manager_total_people,
      SUM(CASE WHEN role_id = ? AND manager_id <=> ? THEN users_with_access ELSE 0 END) AS same_manager_with_access,
      SUM(CASE WHEN role_id = ? AND NOT (manager_id <=> ?) THEN total_people ELSE 0 END) AS different_manager_total_people,
      SUM(CASE WHEN role_id = ? AND NOT (manager_id <=> ?) THEN users_with_access ELSE 0 END) AS different_manager_with_access,
      LOWER(MAX(risk_level)) AS risk_level,
      MAX(requestable_by) AS requestable_by
    FROM ROLE_ACCESS_SUMMARY
    WHERE access_type = ?
  `;

  const [result] = await query(sqlQuery, [
    role_id, manager_id,
    role_id, manager_id,
    role_id, manager_id,
    role_id, manager_id,
    accessType
  ]);
  return result;
}

// ─── Batch user fetch (used by bulk route) ────────────────────
// One query for ALL user_ids instead of one per task
async function batchGetUsers(userIds) {
  if (userIds.length === 0) return new Map();

  const placeholders = userIds.map(() => '?').join(', ');
  const rows = await query(`
  SELECT u.id, u.role_id, u.manager_id, r.role_type, r.role_name
  FROM users_access u
  LEFT JOIN roles r ON r.id = u.role_id
  WHERE u.id IN (${placeholders})
  AND LOWER(u.status) = 'active'
`, userIds);

  // Return as Map for O(1) lookup: userId → user
  const userMap = new Map();
  for (const row of rows) {
    userMap.set(row.id, row);
  }
  return userMap;
}


function normalizeManager(managerId) {
  return managerId ?? 'NO_MANAGER';
}

// ─── Batch access details fetch (used by bulk route) ──────────
// One query per unique accessType (not per task)
// Because ROLE_ACCESS_SUMMARY is grouped by access_type
async function batchGetAccessDetails(tasks, userMap) {
  if (tasks.length === 0) return new Map();

  // Group tasks by accessType — many tasks may share the same role
  // so we only query each unique (role_id, manager_id, accessType) combo once
  const uniqueCombos = new Map();

  for (const task of tasks) {
    const user = userMap.get(task.user_id);
    if (!user) continue;

    // const comboKey = `${user.role_id}::${user.manager_id}::${task.requested_role}`;
    const comboKey =
`${user.role_id}::${normalizeManager(user.manager_id)}::${task.requested_role}`;
    if (!uniqueCombos.has(comboKey)) {
      uniqueCombos.set(comboKey, {
        role_id: user.role_id,
        manager_id: user.manager_id,
        accessType: task.requested_role
      });
    }
  }

  // Fetch all unique combos in parallel (still far fewer than N tasks)
  const accessMap = new Map();

  await Promise.all(
    [...uniqueCombos.entries()].map(async ([comboKey, combo]) => {
      try {
        const details = await getAccessDetails(
          combo.role_id,
          combo.manager_id,
          combo.accessType
        );
        accessMap.set(comboKey, details);
      } catch (err) {
        logger.error(`Failed to get access details for ${comboKey}: ${err.message}`);
        accessMap.set(comboKey, null);
      }
    })
  );

  return accessMap;
}

// ─── Single recommendation (single route uses this) ───────────
async function getSingleRecommendation({ userId, accessType, context, mode }) {
  try {
    const user = await getUserForRecommendation(userId);
    console.log(user);
    const accessDetails = await getAccessDetails(user.role_id, user.manager_id, accessType);

    // ✅ Fixed: pass object as second argument to match getRiskScore signature
    const result = getRiskScore(accessDetails, { userId, accessType, context });
    return result;
  } catch (error) {
    logger.error(error);
    throw error; // re-throw so caller can handle
  }
}

// ─── Bulk recommendation (bulk route uses this) ───────────────
async function getBulkRecommendation({ userId, accessType, context, userMap, accessMap }) {
  const user = userMap.get(userId);

  if (!user) {
    throw Object.assign(
      new Error(`User ${userId} not found or inactive`),
      { code: 'USER_NOT_FOUND' }
    );
  }

  // const comboKey = `${user.role_id}::${user.manager_id}::${accessType}`;
  const comboKey =
`${user.role_id}::${normalizeManager(user.manager_id)}::${accessType}`;
  const accessDetails = accessMap.get(comboKey);

  if (!accessDetails) {
    throw new Error(`Access details not found for combo: ${comboKey}`);
  }

  // ✅ Same fixed signature
  const result = getRiskScore(accessDetails, { userId, accessType, context });
  return result;
}

module.exports = {
  getSingleRecommendation,
  getBulkRecommendation,
  batchGetUsers,
  batchGetAccessDetails
};