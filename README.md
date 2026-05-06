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

### Recommendations


#### POST `api/access-requests/bulk`
Bulk recommendations — use for (certification campaigns).

**Request Body:**
```json
{
  "requests": [
    {
      "user_id": "usr-0012-0000-0000-0000-000000000001",
      "items": [
        {
          "requested_role": "AWS EC2 Admin",
          "justification": "hello this is for my single"
        },
        {
          "requested_role": "AWS EC2 Admin",
          "justification": "hello this is for my single"
        }
      ]
    },
    {
      "user_id": "usr-0012-0000-0000-0000-000000000001",
      "items": [
        {
          "requested_role": "AWS EC2 Admin",
          "justification": "hello this is for my single"
        }
      ]
    }
  ]
}
```

**Response:**
```json
{
  "requests": [
    {
      "user_id": "usr-0012-0000-0000-0000-000000000001",
      "items": [
        {
          "requested_role": "AWS EC2 Admin",
          "justification": "hello this is for my single"
        },
        {
          "requested_role": "AWS EC2 Admin",
          "justification": "hello this is for my single"
        }
      ]
    },
    {
      "user_id": "usr-0012-0000-0000-0000-000000000001",
      "items": [
        {
          "requested_role": "AWS EC2 Admin",
          "justification": "hello this is for my single"
        }
      ]
    }
  ]
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
    "proactiveRecommendation": {
        "score": 0,
        "decision": "DO_NOT_RECOMMEND",
        "risk_level": "low",
        "confidence": "0.00",
        "breakdown": {
            "same_manager": {
                "total": 0,
                "with_access": 0,
                "percentage": "0%"
            },
            "different_manager": {
                "total": 0,
                "with_access": 0,
                "percentage": "0%"
            }
        },
        "reason": "Only 0% under same manager and 0% across other managers have this access. \nFor 'low' risk level, this is considered unsafe or uncommon."
    }
}
```

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


