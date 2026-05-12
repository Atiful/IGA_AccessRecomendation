# NextGen IGA — Access Recommendation Engine

Node.js + MySQL implementation of a peer-based Identity Governance & Administration (IGA) recommendation engine.

The system analyzes peer access patterns based on:

* same role
* same manager
* organizational adoption
* risk level

to generate proactive access recommendations before access is granted.

---

# Setup

## 1. Install dependencies

```bash
npm install
```

---

## 2. Configure environment

```bash
cp .env.example .env
```

Configure:

* MySQL credentials
* database name
* port
* environment variables

---

## 3. Start the server

```bash
npm start
```

---

# Project Structure

```text
src/
├── index.js
├── app.js
├── db/
│   └── pool.js
├── config/
│   └── policyConfig.js
├── services/
│   ├── riskScore.js
│   └── recommendationService.js
├── routes/
│   └── accessRequests.js
└── middleware/
    └── errorHandler.js
```

---

# Base URL

```text
https://iga-accessrecomendation.onrender.com
```

---

# API Reference

---

# 1. Single Access Recommendation

## POST `/api/access-requests/`

Used during access request flow.

Returns a recommendation before access is granted.

---

## Request Body

```json
{
  "user_id": "usr-0012-0000-0000-0000-000000000001",
  "requested_role": "AWS EC2 Admin",
  "justification": "Need access for project deployment"
}
```

---

## Fields

| Field            | Type   | Required | Description            |
| ---------------- | ------ | -------- | ---------------------- |
| `user_id`        | string | Yes      | User requesting access |
| `requested_role` | string | Yes      | Access entitlement     |
| `justification`  | string | No       | Business reason        |

---

## Success Response — `201`

```json
{
  "success": true,
  "proactiveRecommendation": {
    "userId": "usr-0012-0000-0000-0000-000000000001",
    "accessType": "AWS EC2 Admin",
    "score": 0.365,
    "decision": "DO_NOT_RECOMMEND",
    "risk_level": "high",
    "confidence": "37",
    "breakdown": {
      "same_manager": {
        "total": 20,
        "with_access": 7,
        "percentage": "35%"
      },
      "different_manager": {
        "total": 30,
        "with_access": 12,
        "percentage": "40%"
      }
    },
    "reason": "Only 35% under same manager and 40% across other managers have this access. For 'high' risk level, this is considered unsafe or uncommon."
  }
}
```

---

## Decision Values

| Decision                 |
| ------------------------ |
| `STRONGLY_RECOMMEND`     |
| `RECOMMEND_WITH_CAUTION` |
| `DO_NOT_RECOMMEND`       |

---

## Error Responses

| Status | Error                   | Cause                             |
| ------ | ----------------------- | --------------------------------- |
| `400`  | `MISSING_FIELDS`        | Missing user_id or requested_role |
| `409`  | `ALREADY_HAS_ACCESS`    | User already has access           |
| `500`  | `RECOMMENDATION_FAILED` | Internal scoring error            |

---

# 2. Manager Access Review

## POST `/api/access-requests/manager-review`

Audits all users under a manager.

The API:

* checks risky existing access
* checks missing but strongly recommended access
* returns only actionable results

This route uses the stable single recommendation engine internally.

---

## Request Body

```json
{
  "manager_id": "adas"
}
```

---

## Success Response — `200`

```json
{
  "success": true,
  "manager_id": "adas",
  "total_flagged": 2,
  "results": [
    {
      "user_id": "usr-001",
      "access_type": "Microsoft",
      "status": "risky_access",
      "recommendation": {
        "decision": "DO_NOT_RECOMMEND",
        "risk_level": "high"
      }
    },
    {
      "user_id": "usr-002",
      "access_type": "Saviynt",
      "status": "recommended_to_grant",
      "recommendation": {
        "decision": "STRONGLY_RECOMMEND",
        "risk_level": "low"
      }
    }
  ]
}
```

---

## Result Statuses

| Status                 | Meaning                              |
| ---------------------- | ------------------------------------ |
| `risky_access`         | User has uncommon/risky access       |
| `recommended_to_grant` | User is missing commonly used access |

---

# Recommendation Logic

The engine computes peer-based access frequency using:

```text
L1 = same role + same manager
L2 = same role across organization
```

---

## Formula

```text
score = (L1_weight × L1_freq) + (L2_weight × L2_freq)
```

Where:

```text
L1_freq = peers_with_access / total_peers_same_manager
L2_freq = peers_with_access / total_peers_other_managers
```

---

# Risk-Based Policies

Different risk levels use different:

* weights
* thresholds
* recommendation strictness

Examples:

* low risk → easier to recommend
* high risk → stricter recommendation logic

---

# Confidence Calculation

Confidence is dynamically generated from:

* peer adoption
* risk thresholds
* recommendation score

Range:

```text
0 → 100
```

---

# Database Tables Used

| Table                 | Purpose                    |
| --------------------- | -------------------------- |
| `users_access`        | User-role-manager mapping  |
| `user_access`         | Actual application access  |
| `ROLE_ACCESS_SUMMARY` | Precomputed peer analytics |
| `roles`               | Role metadata              |
| `applications`        | Application metadata       |

---

# Architecture Notes

## Precomputed Analytics Layer

`ROLE_ACCESS_SUMMARY` stores:

```text
(role_id, manager_id, access_type)
```

aggregated statistics to avoid expensive runtime calculations.

---

## Access Recommendation Flow

```text
User Request
   ↓
Fetch User Context
   ↓
Fetch Peer Statistics
   ↓
Risk Score Calculation
   ↓
Decision Generation
   ↓
Human-readable Explanation
```

---

# Technologies Used

* Node.js
* Express.js
* MySQL
* mysql2
* REST API
* Peer-based analytics
* Risk scoring engine

---

# Author

NextGen IGA Access Recommendation Engine
