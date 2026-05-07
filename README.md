# NextGen IGA — Access Recommendation Engine

Node.js + MySQL implementation of the IGA Access Recommendation Engine as described in the Technical Design Document.

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```

### 3. Start the server
```bash
npm start
```

---

## Project Structure

```
src/
├── index.js                       # Boot + graceful shutdown
├── app.js                         # Express app + middleware
├── db/
│   └── pool.js                    # MySQL connection pool + helpers
├── config/
│   └── policyConfig.js            # Weights + thresholds with hot-reload
├── services/
│   ├── riskScore.js               # Core L1/L2 weighted scoring + decision logic
│   └── recommendationService.js   # Orchestrator — single + bulk recommendation
├── routes/
│   └── accessRequests.js          # /api/access-requests (single + bulk)
└── middleware/
    └── errorHandler.js            # Centralized error handling
```

---

## API Reference

Base URL: `/api/access-requests`

---

### POST `/api/access-requests/`

Single recommendation — use during the **access request flow** (Stage 1: Proactive Prevention).

Called when a user selects an entitlement. Returns a peer-based recommendation before the request is submitted, so risky or unjustified requests can be caught early.

**Request Body**

```json
{
  "user_id":        "usr-0012-0000-0000-0000-000000000001",
  "requested_role": "AWS EC2 Admin",
  "justification":  "Need access for project deployment"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `user_id` | string | Yes | Unique identifier of the requesting user |
| `requested_role` | string | Yes | The access entitlement / role being requested |
| `justification` | string | No | Business reason provided by the user |

**Success Response — `201 Created`**

```json
{
  "success": true,
  "proactiveRecommendation": {
    "userId":     "usr-0012-0000-0000-0000-000000000001",
    "accessType": "AWS EC2 Admin",
    "score":      0.365,
    "decision":   "DO_NOT_RECOMMEND",
    "risk_level": "high",
    "confidence": "0.37",
    "breakdown": {
      "same_manager":      { "total": 20, "with_access": 7,  "percentage": "35%" },
      "different_manager": { "total": 30, "with_access": 12, "percentage": "40%" }
    },
    "reason": "Only 35% under same manager and 40% across other managers have this access. For 'high' risk level, this is considered unsafe or uncommon. High-risk access requires stronger justification."
  }
}
```

**Decision Values**

| Decision
|---|
| `STRONGLY_RECOMMEND`
| `RECOMMEND_WITH_CAUTION`
| `DO_NOT_RECOMMEND`

**Error Responses**

| Status | Error Code | Cause |
|---|---|---|
| `400` | `MISSING_FIELDS` | `user_id` or `requested_role` not provided |
| `409` | `ALREADY_HAS_ACCESS` | User already holds active access for this entitlement |
| `500` | `RECOMMENDATION_FAILED` | Internal error during scoring calculation |

---

### POST `/api/access-requests/bulk`

Bulk recommendations — use for **certification campaigns** (Stage 3: Access Review).

Accepts multiple users and roles in a single request. Applies deduplication, batched DB queries, and concurrency limiting internally — safe to call with large payloads.

**Limits:** max **500 unique** user+role pairs per request.

**Request Body**

```json
{
  "requests": [
    {
      "user_id": "usr-0012-0000-0000-0000-000000000001",
      "items": [
        { "requested_role": "AWS EC2 Admin", "justification": "Needed for deployments" },
        { "requested_role": "S3 Read",       "justification": "Log access" }
      ]
    },
    {
      "user_id": "usr-0012-0000-0000-0000-000000000002",
      "items": [
        { "requested_role": "AWS EC2 Admin", "justification": "Project requirement" }
      ]
    }
  ]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `requests` | array | Yes | Array of user request objects |
| `requests[].user_id` | string | Yes | Unique identifier of the user |
| `requests[].items` | array | Yes | Array of role items for this user |
| `items[].requested_role` | string | Yes | The access entitlement being evaluated |
| `items[].justification` | string | No | Business reason for the request |

**Success Response — `200 OK`**

```json
{
  "success": true,
  "total": 3,
  "summary": { "success": 2, "skipped": 1, "failed": 0 },
  "results": [
    {
      "user_id":        "usr-0012-0000-0000-0000-000000000001",
      "requested_role": "AWS EC2 Admin",
      "justification":  "Needed for deployments",
      "status":         "success",
      "proactiveRecommendation": {
        "userId":     "usr-0012-0000-0000-0000-000000000001",
        "accessType": "AWS EC2 Admin",
        "score":      0.72,
        "decision":   "STRONGLY_RECOMMEND",
        "risk_level": "low",
        "confidence": "0.72",
        "breakdown": {
          "same_manager":      { "total": 20, "with_access": 16, "percentage": "80%" },
          "different_manager": { "total": 30, "with_access": 18, "percentage": "60%" }
        },
        "reason": "80% of users under the same manager already have this access. Given 'low' risk level, this is considered safe to grant."
      }
    },
    {
      "user_id":        "usr-0012-0000-0000-0000-000000000001",
      "requested_role": "S3 Read",
      "status":         "skipped",
      "error":          "ALREADY_HAS_ACCESS"
    },
    {
      "user_id":        "usr-0012-0000-0000-0000-000000000002",
      "requested_role": "AWS EC2 Admin",
      "justification":  "Project requirement",
      "status":         "success",
      "proactiveRecommendation": { "...": "..." }
    }
  ]
}
```

**Per-Result Status Values**

| Status | Meaning |
|---|---|
| `success` | Recommendation computed and returned |
| `skipped` | User already has active access — no recommendation needed |
| `failed` | Error for this specific task — other tasks in the batch are unaffected |

**Error Responses**

| Status | Error Code | Cause |
|---|---|---|
| `400` | `INVALID_INPUT` | `requests` is missing, not an array, or empty |
| `400` | `NO_VALID_TASKS` | All items were invalid after parsing and deduplication |
| `400` | `TOO_MANY_TASKS` | More than 500 unique user+role pairs in a single request |
| `500` | `INTERNAL_ERROR` | Unexpected server-side error |

---

## Architecture Notes

### Scoring Algorithm

```
score = (L1_weight × L1_freq) + (L2_weight × L2_freq)

Where:
  L1_freq = peers_with_access / total_peers  (same role + same manager)
  L2_freq = peers_with_access / total_peers  (same role, any manager)

Default weights: L1=0.7, L2=0.3 (configurable per risk level in policyConfig.js)
```

### Double-Buffer Board Pattern

Peer frequency counters are stored in two boards (A and B). Reads always go to the active board. Updates write to the standby board then atomically switch — guaranteeing users **never read partially-written data**.

### Fallback Chain (Cold Start)

When peer data is insufficient (below `MIN_PEER_GROUP_SIZE`, default 5):

1. L1 peers — same role + same manager
2. L2 peers — same role, any manager
3. Global — same role across the entire org
4. Department — same department defaults
5. Admin-defined baseline — hardcoded safe defaults

### Bulk API — Performance Optimizations

The bulk endpoint avoids the naive pattern of one DB query per task. Instead it runs a multi-stage pipeline:

| Step | What Happens | DB Queries |
|---|---|---|
| Deduplicate | Drop identical user+role pairs within the same request | 0 |
| Batch access check | One query checks all pairs against `USER_ACCESS` | 1 |
| Batch user fetch | One query fetches all unique users with `role_id` and `manager_id` | 1 |
| Batch access details | One query per unique `(role_id, manager_id, role)` combo | ~10–15 |
| pLimit concurrency | Scoring runs through a sliding window of max 10 concurrent tasks | 0 |

                    
```