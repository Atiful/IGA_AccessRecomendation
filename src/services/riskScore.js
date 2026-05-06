const { RISK_POLICY } = require('../config/policyConfig.js');


function computeConfidence(score, policy) {
  const { strong, moderate } = policy.thresholds;

  let confidence;

  if (score >= strong) {
    // High zone (80–100%)
    const range = 1 - strong;
    confidence = 80 + ((score - strong) / range) * 20;
  } else if (score >= moderate) {
    // Medium zone (40–80%)
    const range = strong - moderate;
    confidence = 40 + ((score - moderate) / range) * 40;
  } else {
    // Low zone (0–40%)
    const range = moderate;
    confidence = (score / range) * 40;
  }

  return Math.min(100, Math.max(0, confidence)).toFixed(0);
}




function getRiskScore(data , { userId, accessType, context}) {
  // 🔹 Convert strings → numbers
  const sameTotal = Number(data.same_manager_total_people) || 0;
  const sameAccess = Number(data.same_manager_with_access) || 0;
  const diffTotal = Number(data.different_manager_total_people) || 0;
  const diffAccess = Number(data.different_manager_with_access) || 0;

  const risk = data.risk_level || "low";
  const policy = RISK_POLICY[risk];

  // 🔹 Frequencies
  const L1_freq = sameTotal ? sameAccess / sameTotal : 0;
  const L2_freq = diffTotal ? diffAccess / diffTotal : 0;

  // 🔹 Score
  const score =
    policy.L1_weight * L1_freq +
    policy.L2_weight * L2_freq;

  // 🔹 Decision
  let decision;
  if (score > policy.thresholds.strong) {
    decision = "STRONGLY_RECOMMEND";
  } else if (score >= policy.thresholds.moderate) {
    decision = "RECOMMEND_WITH_CAUTION";
  } else {
    decision = "DO_NOT_RECOMMEND";
  }

  // 🔹 Percent values (for explanation)
  const samePercent = (L1_freq * 100).toFixed(0);
  const diffPercent = (L2_freq * 100).toFixed(0);

  // 🔹 Reason generation (dynamic)
  let reason = "";

  if (decision === "STRONGLY_RECOMMEND") {
    reason = `${samePercent}% of users under the same manager already have this access. 
Given '${risk}' risk level, this is considered safe to grant.`;
  } 
  else if (decision === "RECOMMEND_WITH_CAUTION") {
    reason = `${samePercent}% of users under the same manager and ${diffPercent}% across other managers have this access. 
Moderate adoption observed with '${risk}' risk — manual review suggested.`;
  } 
  else {
    reason = `Only ${samePercent}% under same manager and ${diffPercent}% across other managers have this access. 
For '${risk}' risk level, this is considered unsafe or uncommon.`;
  }

  // 🔹 Extra strict message for high/critical
  if ((risk === "high" || risk === "critical") && decision !== "STRONGLY_RECOMMEND") {
    reason += ` High-risk access requires stronger justification.`;
  }
  

  confidence = computeConfidence(score , policy);

  return {
    userId : userId,
    accessType : accessType,
    score: Number(score.toFixed(3)),
    decision,
    risk_level: risk,
    confidence: score.toFixed(2),
    breakdown: {
      same_manager: {
        total: sameTotal,
        with_access: sameAccess,
        percentage: `${samePercent}%`
      },
      different_manager: {
        total: diffTotal,
        with_access: diffAccess,
        percentage: `${diffPercent}%`
      }
    },
    reason
  };
}

module.exports = {  getRiskScore };