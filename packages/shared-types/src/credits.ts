/**
 * Credit costs for billable operations. Centralised and configurable —
 * the API reads these defaults; per-plan overrides can layer on later.
 */

export const CREDIT_COSTS = {
  importVideo: 1,
  generateHighlights: 2,
  /** Render cost scales with duration: ceil(seconds / 30) * renderPer30s */
  renderPer30s: 2,
} as const;

export function renderCost(durationSeconds: number): number {
  return Math.max(
    CREDIT_COSTS.renderPer30s,
    Math.ceil(durationSeconds / 30) * CREDIT_COSTS.renderPer30s,
  );
}

export const PLAN_LIMITS = {
  FREE: { projectsPerMonth: 3, maxResolution: "720p", watermark: true, monthlyCredits: 20 },
  STARTER: { projectsPerMonth: 30, maxResolution: "1080p", watermark: false, monthlyCredits: 200 },
  PRO: { projectsPerMonth: 150, maxResolution: "2160p", watermark: false, monthlyCredits: 1000 },
  BUSINESS: { projectsPerMonth: 1000, maxResolution: "2160p", watermark: false, monthlyCredits: 5000 },
} as const;

export type PlanName = keyof typeof PLAN_LIMITS;
