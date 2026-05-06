// src/routes/accessRequests.js
// Access request lifecycle with recommendation integration
const express = require('express');
const router = express.Router();
const { query, transaction } = require('../db/pool');
const { getSingleRecommendation } = require('../services/recommendationService');
// const { processEvent } = require('../services/eventProcessor');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger.js');

// POST /access-requests
// Submit an access request — recommendation is included in response proactively



router.post('/', async (req, res, next) => {
  try {
    const { user_id, requested_role, justification } = req.body;
     
    if (!user_id || !requested_role) {
      return res.status(400).json({ success: false, error: 'MISSING_FIELDS', message: 'user_id, and requested_role are required' });
    }


  

    // Check if user already has this access
    const alreadyHas = await query(`
      SELECT id FROM USER_ACCESS
      WHERE user_id = ? AND access_type = ? AND status = 'active'
    `, [user_id, requested_role]);

       



    if (alreadyHas.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'ALREADY_HAS_ACCESS',
        message: 'User already has active access for this entitlement',
      });
    }

    // Get proactive recommendation (Stage 1 — before submitting)
    let recommendation = null;
    try {
      recommendation = await getSingleRecommendation({
        userId: user_id,
        accessType: requested_role,
        context: 'REQUEST',
        mode: 'fast',
      });
    } catch (recErr) {
       logger.error(recErr);
      return res.status(409).json({
        success: false,
        error: 'Something went wrong while calculating',
        message: 'Something went wrong while calculating',
      });
     
    }

    res.status(201).json({
      success: true,
     proactiveRecommendation: recommendation
        ? recommendation
        : null,
    });
  } catch (err) {
    next(err);
  }
});




// bulk recomenaddation
router.post('/bulk', async (req, res, next) => {
  try {
    const  {requests}  = req.body;
    console.log(requests);

    if (!Array.isArray(requests) || requests.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_INPUT',
        message: 'requests array is required'
      });
    }

    // Flatten all requests into individual units
    const tasks = [];

    for (const userReq of requests) {
      const { user_id, items } = userReq;

      if (!user_id || !Array.isArray(items)) continue;

      for (const item of items) {
        const { requested_role, justification } = item;

        if (!requested_role) continue;

        tasks.push({
          user_id,
          requested_role,
          justification
        });
      }
    }

    // Process all tasks in parallel
    const results = await Promise.all(
      tasks.map(async (task) => {
        const { user_id, requested_role, justification } = task;

        try {
          // Step 1: Check existing access
          const alreadyHas = await query(`
            SELECT id FROM USER_ACCESS
            WHERE user_id = ? AND access_type = ? AND status = 'active'
          `, [user_id, requested_role]);

          if (alreadyHas.length > 0) {
            return {
              user_id,
              requested_role,
              status: 'skipped',
              error: 'ALREADY_HAS_ACCESS'
            };
          }

          // Step 2: Get recommendation
          const recommendation = await getSingleRecommendation({
            userId: user_id,
            accessType: requested_role,
            context: 'REQUEST',
            mode: 'fast'
          });

          return {
            user_id,
            requested_role,
            justification,
            status: 'success',
            proactiveRecommendation: recommendation || null
          };

        } catch (err) {
          logger.error(err);

          return {
            user_id,
            requested_role,
            status: 'failed',
            error: err.message
          };
        }
      })
    );

    res.status(200).json({
      success: true,
      total: tasks.length,
      results
    });

  } catch (err) {
    next(err);
  }
});


module.exports = router;
