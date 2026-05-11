const express = require('express');
const router = express.Router();
const pLimit = require('p-limit');
const { query } = require('../db/pool');
const {
  getSingleRecommendation,
  getBulkRecommendation,
  batchGetUsers,
  batchGetAccessDetails
} = require('../services/recommendationService');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger.js');

const MAX_TASKS   = 500;
const CONCURRENCY = 10;

// ─── Helper: deduplicate tasks ────────────────────────────────
function deduplicateTasks(requests) {
  const seen  = new Set();
  const tasks = [];

  for (const userReq of requests) {
    const { user_id, items } = userReq;
    if (!user_id || !Array.isArray(items)) continue;

    for (const item of items) {
      const { requested_role, justification } = item;
      if (!requested_role) continue;

      const key = `${user_id}::${requested_role}`;
      if (seen.has(key)) continue;   // drop duplicate
      seen.add(key);

      tasks.push({ user_id, requested_role, justification });
    }
  }

  return tasks;
}

// ─── Helper: batch check existing access ──────────────────────
// 1 query instead of N queries
async function getExistingAccessSet(tasks) {
  if (tasks.length === 0) return new Set();

  const conditions = tasks.map(() => '(user_id = ? AND application_id = ?)').join(' OR ');
  const values     = tasks.flatMap(t => [t.user_id, t.requested_role]);

  const rows = await query(`
    SELECT user_id, application_id
    FROM user_access
    WHERE (${conditions}) AND status = 'active'
  `, values);

  const existingSet = new Set();
  for (const row of rows) {
    existingSet.add(`${row.user_id}::${row.access_type}`);
  }
  return existingSet;
}



// ──────────────────────────────────────────────────────────────
// POST /access-requests  (single)
// ──────────────────────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { user_id, requested_role, justification } = req.body;

    if (!user_id || !requested_role) {
      return res.status(400).json({
        success: false,
        error  : 'MISSING_FIELDS',
        message: 'user_id and requested_role are required'
      });
    }

    // Check existing access
    // const alreadyHas = await query(`
    //   SELECT id FROM USER_ACCESS
    //   WHERE user_id = ? AND access_type = ? AND status = 'active'
    // `, [user_id, requested_role]);

     const alreadyHas = await query(`
      SELECT id FROM user_access
      WHERE user_id = ? AND application_id = ? AND LOWER(status) = 'active'
    `, [user_id, requested_role]);

    if (alreadyHas.length > 0) {
      return res.status(409).json({
        success: false,
        error  : 'ALREADY_HAS_ACCESS',
        message: 'User already has active access for this entitlement',
      });
    }

    // Get recommendation
    let recommendation = null;
    try {
      recommendation = await getSingleRecommendation({
        userId    : user_id,
        accessType: requested_role,
        context   : 'REQUEST',
        mode      : 'fast',
      });
    } catch (recErr) {
      logger.error(recErr);
      return res.status(500).json({
        success: false,
        error  : 'RECOMMENDATION_FAILED',
        message: recErr,
      });
    }

    res.status(201).json({
      success                : true,
      proactiveRecommendation: recommendation || null,
    });

  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────
// POST /access-requests/bulk
// ──────────────────────────────────────────────────────────────
router.post('/bulk', async (req, res, next) => {
  try {
    const { requests } = req.body;

    if (!Array.isArray(requests) || requests.length === 0) {
      return res.status(400).json({
        success: false,
        error  : 'INVALID_INPUT',
        message: 'requests array is required'
      });
    }

    // Step 1 — Deduplicate
    const tasks = deduplicateTasks(requests);

    if (tasks.length === 0) {
      return res.status(400).json({
        success: false,
        error  : 'NO_VALID_TASKS',
        message: 'No valid tasks found'
      });
    }

    // Step 2 — Hard cap
    if (tasks.length > MAX_TASKS) {
      return res.status(400).json({
        success: false,
        error  : 'TOO_MANY_TASKS',
        message: `Max ${MAX_TASKS} unique tasks per request`
      });
    }

    // Step 3 — Batch DB: existing access check (1 query)
    const existingAccessSet = await getExistingAccessSet(tasks);

    // Step 4 — Batch DB: fetch all users (1 query)
    const uniqueUserIds = [...new Set(tasks.map(t => t.user_id))];
    const userMap = await batchGetUsers(uniqueUserIds);

    // Step 5 — Batch DB: fetch all access details (1 query per unique combo)
    // Filter to only tasks that actually need processing
    const tasksToProcess = tasks.filter(t =>
      !existingAccessSet.has(`${t.user_id}::${t.requested_role}`)
    );
    const accessMap = await batchGetAccessDetails(tasksToProcess, userMap);

    // Step 6 — Process with pLimit (only AI/scoring, no DB calls inside)
    const limit = pLimit(CONCURRENCY);

    const results = await Promise.all(
      tasks.map(task => limit(async () => {
        const { user_id, requested_role, justification } = task;
        const key = `${user_id}::${requested_role}`;

        // Already has access — skip instantly (no DB, just Set lookup)
        if (existingAccessSet.has(key)) {
          return {
            user_id,
            requested_role,
            status: 'skipped',
            error : 'ALREADY_HAS_ACCESS'
          };
        }

        try {
          // No DB calls here — userMap and accessMap already have everything
          const recommendation = await getBulkRecommendation({
            userId    : user_id,
            accessType: requested_role,
            context   : 'REQUEST',
            userMap,
            accessMap
          });

          return {
            user_id,
            requested_role,
            justification,
            status                 : 'success',
            proactiveRecommendation: recommendation || null
          };

        } catch (err) {
          logger.error(err);
          return {
            user_id,
            requested_role,
            status: 'failed',
            error : err.message
          };
        }
      }))
    );

    // Step 7 — Summary
    const summary = results.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});

    res.status(200).json({
      success: true,
      total  : tasks.length,
      summary,
      results
    });

  } catch (err) {
    next(err);
  }
});


router.get("/access-review" , (req , res) => {
 res.json("hello");
});

router.post('/access-review', async (req, res, next) => {
  try {
    const { requests } = req.body;

    if (!Array.isArray(requests) || requests.length === 0) {
      return res.status(400).json({
        success: false,
        error  : 'INVALID_INPUT',
        message: 'requests array is required'
      });
    }

    // Step 1 — Deduplicate
    const tasks = deduplicateTasks(requests);

    if (tasks.length === 0) {
      return res.status(400).json({
        success: false,
        error  : 'NO_VALID_TASKS',
        message: 'No valid tasks found'
      });
    }

    // Step 2 — Hard cap
    if (tasks.length > MAX_TASKS) {
      return res.status(400).json({
        success: false,
        error  : 'TOO_MANY_TASKS',
        message: `Max ${MAX_TASKS} unique tasks per request`
      });
    }

    // Step 3 — Batch DB: existing access check (1 query)
    const existingAccessSet = await getExistingAccessSet(tasks);

    // Step 4 — Batch DB: fetch all users (1 query)
    const uniqueUserIds = [...new Set(tasks.map(t => t.user_id))];
    const userMap = await batchGetUsers(uniqueUserIds);

    // Step 5 — Batch DB: fetch all access details for ALL tasks
    const accessMap = await batchGetAccessDetails(tasks, userMap);

    // Step 6 — Process with pLimit
    const limit = pLimit(CONCURRENCY);

    const results = await Promise.all(
      tasks.map(task => limit(async () => {
        const { user_id, requested_role, justification } = task;
        const key       = `${user_id}::${requested_role}`;
        const hasAccess = existingAccessSet.has(key);

        let recommendation = null;
        try {
          recommendation = await getBulkRecommendation({
            userId    : user_id,
            accessType: requested_role,
            context   : 'REQUEST',
            userMap,
            accessMap
          });
        } catch (err) {
          logger.error(err);
          return {
            user_id,
            requested_role,
            justification,
            has_access: hasAccess,
            status    : 'failed',
            error     : err.message
          };
        }

        const decision = recommendation?.decision;

        // ── Case 1: Has access AND risky — flag it ────────────────────
        if (hasAccess && decision === 'DO_NOT_RECOMMEND') {
          return {
            user_id,
            requested_role,
            justification,
            has_access             : true,
            status                 : 'risky_access',
            message                : 'User has this access but it is flagged as risky or uncommon',
            proactiveRecommendation: recommendation
          };
        }

        // ── Case 2: Has access AND fine — no action needed, drop it ───
        if (hasAccess) {
          return null;
        }

        // ── Case 3: No access AND strongly recommended — flag it ──────
        if (decision === 'STRONGLY_RECOMMEND') {
          return {
            user_id,
            requested_role,
            justification,
            has_access             : false,
            status                 : 'recommended_to_grant',
            message                : 'User does not have this access but it is strongly recommended',
            proactiveRecommendation: recommendation
          };
        }

        // ── Case 4: No access AND not recommended — no action needed, drop it
        return null;
      }))
    );

    // Step 7 — Filter out nulls (no-action cases)
    const filteredResults = results.filter(r => r !== null);

    // Step 8 — Summary
    const summary = filteredResults.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});

    res.status(200).json({
      success: true,
      total  : tasks.length,
      flagged: filteredResults.length,
      summary,
      results: filteredResults
    });

  } catch (err) {
    next(err);
  }
});

module.exports = router;