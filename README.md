# NextGen IGA — Access Recommendation Engine

Node.js + MySQL implementation of the full IGA Access Recommendation Engine as described in the Technical Design Document.

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env
```



### 4. Start the server
```bash
npm start       # production
npm run dev     # development (nodemon)
```

---

## Project Structure

```
src/
├── index.js                    # Boot + graceful shutdown
├── app.js                      # Express app + middleware
├── db/
│   ├── pool.js                 # MySQL connection pool + helpers
├── config/
│   └── policyConfig.js         # Weights + thresholds with hot-reload
├── services/
│   ├── scoringEngine.js        # Core L1/L2 weighted scoring algorithm
│   └── recommendationService.js # Orchestrator + decision logger
├── routes/
│   ├── recommendations.js      # /api/recommendations (single, bulk)
└── middleware/
    └── errorHandler.js         # Centralized error handling
```

---

## API Reference

### Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Basic health check (load balancer probe) |
| GET | `/api/admin/health` | Detailed health with board + DB status |

---

### Recommendations

#### POST `/api/recommendations`
Single recommendation — use at Stage 1 (access request) and Stage 2 (approval review).

**Request Body:**
```json
{
  "user_id":        "uuid",
  "application_id": "uuid",
  "access_type":    "WRITE",
  "context":        "REQUEST",   // REQUEST | APPROVAL | REVIEW
  "mode":           "fast"       // fast (precomputed) | accurate (real-time)
}
```
> Note: `mode` is automatically overridden to `accurate` for privileged access types (ADMIN, ROOT, etc.)

**Response:**
```json
{
  "success": true,
  "data": {
    "userId": "...",
    "applicationId": "...",
    "applicationName": "AWS Console",
    "accessType": "WRITE",
    "score": 0.365,
    "recommendation": "DO_NOT_RECOMMEND",   // STRONGLY_RECOMMEND | RECOMMEND_WITH_CAUTION | DO_NOT_RECOMMEND | RECOMMEND_WITH_STRICT_APPROVAL | MANUAL_REVIEW_REQUIRED
    "confidence": "LOW",                    // HIGH | MEDIUM | LOW
    "riskScore": 5,                         // 1-10
    "reason": "18% of direct peers and 22% of extended peers have this access. Weighted score: 0.365.",
    "isPrivileged": false,
    "privilegeOverride": false,
    "weights": { "L1": 0.7, "L2": 0.3 },
    "breakdown": {
      "l1Contribution": 0.245,
      "l2Contribution": 0.12,
      "l1Freq": 0.35,
      "l2Freq": 0.40
    },
    "peerCounts": {
      "l1Total": 20, "l1WithAccess": 7,
      "l2Total": 30, "l2WithAccess": 12
    },
    "fallbackUsed": null,
    "dataFreshness": "2025-01-15T10:30:00Z",
    "mode": "fast"
  }
}
```

---

#### POST `/api/recommendations/bulk`
Bulk recommendations — use for Stage 3 (certification campaigns, up to 500 items).

**Request Body:**
```json
{
  "items": [
    { "user_id": "uuid1", "application_id": "uuid_aws", "access_type": "ADMIN", "context": "REVIEW" },
    { "user_id": "uuid2", "application_id": "uuid_jira", "access_type": "READ",  "context": "REVIEW" }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "total": 2,
  "processed": 2,
  "failed": 0,
  "results": [ ...array of individual recommendation objects... ],
  "errors": []
}
```

---

#### POST `/api/recommendations/explain`
Explainability API — full audit trail, weights, and thresholds used for a decision.

**Request Body:**
```json
{
  "user_id":        "uuid",
  "application_id": "uuid",
  "access_type":    "ADMIN"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "isPrivileged": true,
    "liveRecommendation": { "score": 0.31, "recommendation": "DO_NOT_RECOMMEND", ... },
    "details": {
      "same_manager_peers":  "7/20 (35%)",
      "cross_manager_peers": "12/30 (40%)"
    },
    "weights": { "L1": 0.7, "L2": 0.3 },
    "scoreBreakdown": { "l1Contribution": 0.245, "l2Contribution": 0.120 },
    "finalScore": 0.365,
    "thresholdUsed": { "strongRecommend": 0.8, "recommendCaution": 0.5 },
    "decision": "DO_NOT_RECOMMEND",
    "privilegeOverrideApplied": true,
    "fallbackUsed": null,
    "dataFreshness": "...",
    "lastDecisionAt": "...",
    "auditSnapshot": { "scoreAtDecisionTime": 0.365, "recommendationAtDecisionTime": "DO_NOT_RECOMMEND", "modeUsed": "accurate" }
  }
}
```

---

#### GET `/api/recommendations/history/:userId`
Decision history for a specific user.

Query params: `limit` (max 100), `offset`

---

### Events (Internal Event Bus)

#### POST `/api/events`
Ingest an IGA lifecycle event. All events are idempotent — duplicate `event_id` is a no-op.

**Supported event types:**

| Event Type | Required Payload Fields |
|------------|------------------------|
| `ACCESS_GRANTED` | `user_id`, `application_id`, `access_type` |
| `ACCESS_REVOKED` | `user_id`, `application_id`, `access_type` |
| `ACCESS_EXPIRED` | `user_id`, `application_id`, `access_type` |
| `USER_UPDATED`   | `user_id`, `old_role_id`, `old_manager_id`, `new_role_id`, `new_manager_id` |

**Request Body:**
```json
{
  "event_id":   "unique-event-uuid-or-string",
  "event_type": "ACCESS_GRANTED",
  "payload": {
    "user_id":        "uuid",
    "application_id": "uuid",
    "access_type":    "WRITE"
  }
}
```

**Edge cases handled automatically:**
- **Duplicate events** → detected by `event_id`, skipped with `DUPLICATE_SKIPPED`
- **Out-of-order events** → state-based validation prevents negative counters
- **USER_UPDATED** → atomically removes from old peer group, adds to new

---

### Access Requests

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/api/access-requests` | List requests (filters: status, user_id, application_id) |
| POST   | `/api/access-requests` | Submit new request (returns proactive recommendation) |
| GET    | `/api/access-requests/:id` | Get request + approver recommendation |
| PATCH  | `/api/access-requests/:id/approve` | Approve + provision access + emit event |
| PATCH  | `/api/access-requests/:id/deny` | Deny request + notify user |

**POST body:**
```json
{
  "user_id": "uuid",
  "application_id": "uuid",
  "requested_role": "WRITE",
  "justification": "Need access for Q1 project"
}
```

**Error cases handled:**
- `DUPLICATE_REQUEST` — pending request already exists
- `ALREADY_HAS_ACCESS` — user already has active access

---

### Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/api/admin/health` | Full component health check |
| GET    | `/api/admin/board/status` | Show active/standby board stats |
| POST   | `/api/admin/board/rebuild` | Trigger full standby board rebuild + atomic switch |
| GET    | `/api/admin/config` | View loaded weight + threshold configs |
| POST   | `/api/admin/config/reload` | Hot-reload configs without restart |
| PUT    | `/api/admin/config/weights/:scopeKey` | Update L1/L2 weights for a scope |
| PUT    | `/api/admin/config/thresholds/:scopeKey` | Update thresholds for a scope |
| GET    | `/api/admin/audit-logs` | View audit logs (filterable) |

**Update weights example:**
```json
PUT /api/admin/config/weights/finance
{
  "l1_weight": 0.8,
  "l2_weight": 0.2
}
```
Constraint: `l1_weight + l2_weight` must equal `1.0`

---

### Users

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/api/users` | List users (filters: role_id, manager_id, status) |
| GET    | `/api/users/:id` | Get user with role, manager, and active accesses |
| GET    | `/api/users/:id/access` | Get all active access for a user |

---

## Architecture Notes

### Double-Buffer Board Pattern
Peer frequency counters are stored in two boards (A and B). Reads always go to the active board. Updates write to the standby board then atomically switch — guaranteeing users **never read partially-written data**.

### Scoring Algorithm
```
score = (L1_weight × L1_freq) + (L2_weight × L2_freq)

Where:
  L1_freq = peers_with_access / total_peers  (same role + same manager)
  L2_freq = peers_with_access / total_peers  (same role, any manager)
  
Default weights: L1=0.7, L2=0.3 (configurable per role_type)
```

### Fallback Chain (Cold Start)
When peer data is insufficient (< `MIN_PEER_GROUP_SIZE`, default 5):
1. L1 peers (same role + manager)
2. L2 peers (same role, any manager)  
3. Global (same role, entire org)
4. Department (same role_type)
5. Admin baseline (score=0 → DO_NOT_RECOMMEND)

### Privileged Access Override
For access types: `ADMIN`, `ROOT`, `SUPERUSER`, `DB_ADMIN`, `AWS_ADMIN`:
- Always uses `accurate` mode (real-time, not precomputed)
- Applies stricter thresholds (configured per scope key)
- Always requires manual approval flag
