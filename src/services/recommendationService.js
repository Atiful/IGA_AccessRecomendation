// src/services/recommendationService.js
// Orchestrates the full recommendation lifecycle
const { query } = require('../db/pool');
// const { resolvePeerData } = require('./peerCounterService');
// const { computeRecommendation } = require('./scoringEngine');
// const { isPrivilegedAccess, getLastReloaded } = require('../config/policyConfig');
const logger = require('../utils/logger');
const { getRiskScore } = require('./riskScore');

/**
 * Fetch user context for recommendation
 */
async function getUserForRecommendation(userId) {
  const rows = await query(`
    SELECT u.id, u.role_id, u.manager_id, r.role_type, r.role_name
    FROM USERS u
    LEFT JOIN ROLES r ON r.id = u.role_id
    WHERE u.id = ? AND u.status = 'active'
  `, [userId]);

  console.log(rows);

  if (!rows) throw Object.assign(new Error(`User ${userId} not found or inactive`), { code: 'USER_NOT_FOUND', status: 404 });
  return rows[0];
}



// /**
//  * Log every recommendation decision
//  */
// async function logDecision(userId,  accessType, context, result, mode) {
//   try {
//     await query(`
//       INSERT INTO REC_DECISION_LOG
//         (user_id, application_id, access_type, context, mode,
//          l1_total, l1_with_access, l2_total, l2_with_access,
//          l1_weight, l2_weight, score, recommendation, confidence,
//          risk_score, privilege_override, fallback_used, data_freshness)
//       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
//     `, [
//       userId, accessType, context, mode,
//       result.peerCounts.l1Total, result.peerCounts.l1WithAccess,
//       result.peerCounts.l2Total, result.peerCounts.l2WithAccess,
//       result.weights.L1, result.weights.L2,
//       result.score, result.recommendation, result.confidence,
//       result.riskScore, result.privilegeOverride ? 1 : 0,
//       result.fallbackUsed, result.dataFreshness || null,
//     ]);
//   } catch (err) {
//     // Non-fatal — log but don't block the response
//     logger.error('Failed to write decision log', err);
//   }
// }

async function getAccessDetails(role_id , manager_id , accessType){
   const sqlQuery = `
SELECT 
    -- Same role + same manager
    SUM(CASE 
        WHEN role_id = ? 
         AND manager_id <=> ? 
        THEN total_people ELSE 0 
    END) AS same_manager_total_people,

    SUM(CASE 
        WHEN role_id = ? 
         AND manager_id <=> ? 
        THEN users_with_access ELSE 0 
    END) AS same_manager_with_access,

    -- Same role + different manager
    SUM(CASE 
        WHEN role_id = ? 
         AND NOT (manager_id <=> ?) 
        THEN total_people ELSE 0 
    END) AS different_manager_total_people,

    SUM(CASE 
        WHEN role_id = ? 
         AND NOT (manager_id <=> ?) 
        THEN users_with_access ELSE 0 
    END) AS different_manager_with_access,

  
    MAX(risk_level) AS risk_level,
    MAX(requestable_by) AS requestable_by

FROM ROLE_ACCESS_SUMMARY
WHERE access_type = ?;
`;

const [result] = await query(sqlQuery, [
 role_id , manager_id ,
 role_id , manager_id ,
 role_id , manager_id ,
 role_id , manager_id ,
  accessType
]);
return result;

}

// /**
//  Single recommendation
async function getSingleRecommendation({ userId,  accessType, context, mode }) {
    
    try{
       const user = await getUserForRecommendation(userId);   // we get id , role_id , mamager_id , role_type , role_name
      const accessDeatils = await getAccessDetails(user.role_id , user.manager_id , accessType);
      console.log(accessDeatils);
       
      // now the actual calcuation happens
     const result =  getRiskScore(accessDeatils , userId , accessType , context);
     return result;
    }catch(error){
        logger.error(error);
    }



}

// /**
//  * Bulk recommendation — batched for performance
//  */
// async function getBulkRecommendations(items) {
//   const results = [];
//   const errors = [];

//   // Process in parallel (bounded)
//   const BATCH_SIZE = 20;
//   for (let i = 0; i < items.length; i += BATCH_SIZE) {
//     const batch = items.slice(i, i + BATCH_SIZE);
//     const settled = await Promise.allSettled(
//       batch.map(item => getSingleRecommendation({
//         userId: item.user_id,
//         accessType: item.access_type,
//         context: item.context || 'REVIEW',
//         mode: item.mode || 'fast',
//       }))
//     );

//     settled.forEach((s, idx) => {
//       if (s.status === 'fulfilled') {
//         results.push(s.value);
//       } else {
//         errors.push({
//           item: batch[idx],
//           error: s.reason?.message || 'Unknown error',
//           code: s.reason?.code || 'INTERNAL_ERROR',
//         });
//       }
//     });
//   }

//   return { results, errors, total: items.length, processed: results.length, failed: errors.length };
// }

// module.exports = { getSingleRecommendation, getBulkRecommendations , getUserForRecommendation };

module.exports = {  getSingleRecommendation};
