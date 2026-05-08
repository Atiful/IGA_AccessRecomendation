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



# POST `/access-review`

Audits a bulk list of user-role combinations and returns **only actionable results** — entries where access is risky or access is missing but recommended. Clean/irrelevant combinations are silently dropped.

---

## When is a result returned?

| Has Access | Decision | Status Returned | Action Needed |
|---|---|---|---|
| ✅ Yes | `DO_NOT_RECOMMEND` | `risky_access` | Review / revoke |
| ✅ Yes | `RECOMMEND_WITH_CAUTION` | _(dropped)_ | None |
| ✅ Yes | `STRONGLY_RECOMMEND` | _(dropped)_ | None |
| ❌ No | `STRONGLY_RECOMMEND` | `recommended_to_grant` | Grant access |
| ❌ No | `RECOMMEND_WITH_CAUTION` | _(dropped)_ | None |
| ❌ No | `DO_NOT_RECOMMEND` | _(dropped)_ | None |
| Any | Error during processing | `failed` | Investigate |

---

## Request

**Method:** `POST`  
**Content-Type:** `application/json`

### Body

```json
{
  "requests": [
    {
      "user_id": "usr-0017-0000-0000-0000-000000000001",
      "items": [
        { "requested_role": "AWS ReadOnly Access", "justification": "Needed for deployments" },
        { "requested_role": "S3 Read",             "justification": "Log access" }
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

### Field Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `requests` | `array` | ✅ | List of user-role audit requests |
| `requests[].user_id` | `string` | ✅ | Unique identifier of the user |
| `requests[].items` | `array` | ✅ | List of roles to audit for this user |
| `requests[].items[].requested_role` | `string` | ✅ | Role/entitlement name to check |
| `requests[].items[].justification` | `string` | ❌ | Optional reason, passed through to response |

> **Limits:** Max `500` unique `user_id + requested_role` combinations per request. Duplicate combinations are automatically deduplicated.

---

## Response

### Success `200`

```json
{
  "success": true,
  "total": 3,
  "flagged": 2,
  "summary": {
    "risky_access": 1,
    "failed": 1
  },
  "results": [
    {
      "user_id": "usr-0017-0000-0000-0000-000000000001",
      "requested_role": "S3 Read",
      "justification": "Log access",
      "has_access": true,
      "status": "risky_access",
      "message": "User has this access but it is flagged as risky or uncommon",
      "proactiveRecommendation": {
        "userId": "usr-0017-0000-0000-0000-000000000001",
        "accessType": "S3 Read",
        "score": 0,
        "decision": "DO_NOT_RECOMMEND",
        "risk_level": "low",
        "confidence": "0.00",
        "breakdown": {
          "same_manager":      { "total": 0, "with_access": 0, "percentage": "0%" },
          "different_manager": { "total": 0, "with_access": 0, "percentage": "0%" }
        },
        "reason": "Only 0% under same manager and 0% across other managers have this access. For 'low' risk level, this is considered unsafe or uncommon."
      }
    },
    {
      "user_id": "usr-0012-0000-0000-0000-000000000002",
      "requested_role": "AWS EC2 Admin",
      "justification": "Project requirement",
      "has_access": false,
      "status": "failed",
      "error": "User usr-0012-0000-0000-0000-000000000002 not found or inactive"
    }
  ]
}
```

### Response Field Reference

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | Always `true` for a valid response |
| `total` | `number` | Total unique tasks processed (after deduplication) |
| `flagged` | `number` | Count of actionable results returned (excludes dropped entries) |
| `summary` | `object` | Count of each status present in `results` |
| `results` | `array` | Only actionable entries — see statuses below |

### Result Object Fields

| Field | Type | Description |
|---|---|---|
| `user_id` | `string` | User identifier |
| `requested_role` | `string` | Role/entitlement that was audited |
| `justification` | `string` | Passed through from request if provided |
| `has_access` | `boolean` | Whether the user currently holds this access |
| `status` | `string` | One of `risky_access`, `recommended_to_grant`, `failed` |
| `message` | `string` | Human-readable description of the finding |
| `proactiveRecommendation` | `object` | Full recommendation object (absent on `failed`) |
| `error` | `string` | Error detail (only present on `failed`) |

---

## Result Statuses

### `risky_access`
User **has** the access but the recommendation engine returned `DO_NOT_RECOMMEND`.

Indicates the access is statistically uncommon among peers with the same manager or across the organisation, making it a candidate for review or revocation.

```json
{
  "has_access": true,
  "status": "risky_access",
  "message": "User has this access but it is flagged as risky or uncommon"
}
```

---

### `recommended_to_grant`
User **does not have** the access but the recommendation engine returned `STRONGLY_RECOMMEND`.

Indicates a high proportion of peers under the same manager hold this access, suggesting it is standard for the user's role and should likely be provisioned.

```json
{
  "has_access": false,
  "status": "recommended_to_grant",
  "message": "User does not have this access but it is strongly recommended"
}
```

---

### `failed`
The recommendation engine threw an error for this entry (e.g. user not found, inactive user, service error). No `proactiveRecommendation` is returned.

```json
{
  "has_access": false,
  "status": "failed",
  "error": "User usr-0012-0000-0000-0000-000000000002 not found or inactive"
}
```

---

## `proactiveRecommendation` Object

| Field | Type | Description |
|---|---|---|
| `userId` | `string` | User the recommendation was computed for |
| `accessType` | `string` | Role/entitlement evaluated |
| `score` | `number` | Numeric score `0–100` driving the decision |
| `decision` | `string` | `STRONGLY_RECOMMEND`, `RECOMMEND_WITH_CAUTION`, or `DO_NOT_RECOMMEND` |
| `risk_level` | `string` | Sensitivity classification of the role (e.g. `low`, `medium`, `high`) |
| `confidence` | `string` | Confidence of the recommendation as a decimal string e.g. `"0.87"` |
| `breakdown.same_manager` | `object` | Peer stats among users sharing the same manager |
| `breakdown.different_manager` | `object` | Peer stats across the rest of the organisation |
| `reason` | `string` | Human-readable explanation of the decision |

### Decision Values

| Decision | Meaning |
|---|---|
| `STRONGLY_RECOMMEND` | High peer adoption under same manager — access is standard for this role |
| `RECOMMEND_WITH_CAUTION` | Moderate peer adoption — access may be appropriate but warrants review |
| `DO_NOT_RECOMMEND` | Low peer adoption — access is uncommon or atypical, potential security risk |

---

## Error Responses

### `400` — Invalid Input

```json
{ "success": false, "error": "INVALID_INPUT",   "message": "requests array is required" }
{ "success": false, "error": "NO_VALID_TASKS",  "message": "No valid tasks found" }
{ "success": false, "error": "TOO_MANY_TASKS",  "message": "Max 500 unique tasks per request" }
```

### `500` — Server Error

```json
{ "success": false, "error": "INTERNAL_ERROR", "message": "Internal server error" }
```

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