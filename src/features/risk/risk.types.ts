export type RiskLevel = 'low' | 'medium' | 'high';

export interface RiskEvaluation {
  delta: number;       // points this submission adds to the stored score
  totalScore: number;  // projected stored score after update (for level checks)
  level: RiskLevel;    // based on totalScore
  flags: string[];     // signals that fired
}

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  matchedUserId?: number;
}

export const RISK_THRESHOLDS = {
  LOW_MAX: 9,    // 0–9   = low
  MEDIUM_MAX: 19, // 10–19 = medium
  // >= 20 = high
} as const;
