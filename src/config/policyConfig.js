const RISK_POLICY = {
  low: {
    L1_weight: 0.7,
    L2_weight: 0.3,
    thresholds: {
      strong: 0.55,
      moderate: 0.30
    }
  },
  medium: {
    L1_weight: 0.6,
    L2_weight: 0.4,
    thresholds: {
      strong: 0.60,
      moderate: 0.35
    }
  },
  high: {
    L1_weight: 0.5,
    L2_weight: 0.5,
    thresholds: {
      strong: 0.65,
      moderate: 0.40
    }
  },
  critical: {
    L1_weight: 0.4,
    L2_weight: 0.6,
    thresholds: {
      strong: 0.70,
      moderate: 0.45
    }
  }
};

module.exports = { RISK_POLICY };
