/**
 * GLM Coding Plan usage (international + China regions)
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U } from "./shared.js";

// GLM quota endpoints (region-aware) — url from registry transport.usage
const GLM_QUOTA_URLS = {
  international: U("glm").url,
  china: U("glm-cn").url,
};

/**
 * GLM Coding Plan usage (international + China regions)
 * Supports legacy TOKENS_LIMIT (percentage) and current CREDIT_LIMIT (Max plan, absolute usage).
 */
export async function getGlmUsage(apiKey, provider, proxyOptions = null) {
  if (!apiKey) {
    return { message: "GLM API key not available." };
  }

  const region = provider === "glm-cn" ? "china" : "international";
  const quotaUrl = GLM_QUOTA_URLS[region];

  try {
    const response = await proxyAwareFetch(
      quotaUrl,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );

    if (!response.ok) {
      if (response.status === 401) {
        return { message: "GLM API key invalid or expired." };
      }
      return { message: `GLM quota API error (${response.status}).` };
    }

    const json = await response.json();
    const data = json?.data && typeof json.data === "object" ? json.data : {};
    const limits = Array.isArray(data.limits) ? data.limits : [];
    const quotas = {};

    // Support both legacy TOKENS_LIMIT and current CREDIT_LIMIT (Max plan).
    // Max plan returns 2x CREDIT_LIMIT entries with distinct unit/number and absolute usage.
    for (let idx = 0; idx < limits.length; idx++) {
      const limit = limits[idx];
      if (!limit || typeof limit !== "object") continue;

      // Only handle limits that carry a percentage or absolute usage
      if (limit.percentage === undefined && limit.usage === undefined) continue;

      const usedPercent = Number(limit.percentage);
      const hasPercent = Number.isFinite(usedPercent);
      const resetMs = Number(limit.nextResetTime) || 0;
      const resetAt = resetMs > 0 ? new Date(resetMs).toISOString() : null;

      // Prefer absolute values when available (CREDIT_LIMIT: usage/currentValue/remaining)
      const hasAbsolute =
        limit.usage != null && limit.currentValue != null && Number.isFinite(Number(limit.usage));
      let used, total, remainingPercentage;

      if (hasAbsolute) {
        total = Number(limit.usage) || 0;
        used = Number(limit.currentValue) || 0;
        const remainingAbs = Number(limit.remaining);
        if (Number.isFinite(remainingAbs) && total > 0) {
          remainingPercentage = Math.round((remainingAbs / total) * 100);
        } else if (hasPercent) {
          remainingPercentage = Math.max(0, 100 - usedPercent);
        } else {
          remainingPercentage = total ? Math.round(((total - used) / total) * 100) : 0;
        }
      } else if (hasPercent) {
        // Legacy percentage-only (TOKENS_LIMIT)
        used = usedPercent;
        total = 100;
        remainingPercentage = Math.max(0, 100 - usedPercent);
      } else {
        continue;
      }

      // Build distinct name — single entry keeps "session" for backward compat,
      // multiple entries use Credits + total to stay distinguishable (e.g. 28k vs 140k)
      let name = "session";
      if (limits.length > 1) {
        const type = typeof limit.type === "string" ? limit.type : "";
        if (type === "CREDIT_LIMIT" && hasAbsolute) {
          const totalAbs = Number(limit.usage) || 0;
          const short = totalAbs >= 1000 ? `${Math.round(totalAbs / 1000)}k` : String(totalAbs);
          name = `Credits ${short}`;
        } else if (type) {
          name = `${type} #${idx + 1}`;
        } else {
          name = `quota #${idx + 1}`;
        }
      } else if (typeof limit.type === "string" && limit.type && limit.type !== "TOKENS_LIMIT") {
        // Single CREDIT_LIMIT — keep generic but still session for UI parity
        name = "session";
      }

      let uniqueName = name;
      let dup = 2;
      while (quotas[uniqueName]) uniqueName = `${name} ${dup++}`;

      // Do NOT set `remaining` as absolute — utils.getRemainingPercentage treats it as 0-100%
      // Forward only remainingPercentage so QuotaTable computes correctly.
      quotas[uniqueName] = {
        used,
        total,
        resetAt,
        remainingPercentage,
        unlimited: false,
      };
    }

    // Fallback for future shape where percentage sits at top level
    if (Object.keys(quotas).length === 0 && typeof data.percentage === "number") {
      const usedPercent = Number(data.percentage) || 0;
      const resetMs = Number(data.nextResetTime) || 0;
      quotas["session"] = {
        used: usedPercent,
        total: 100,
        resetAt: resetMs > 0 ? new Date(resetMs).toISOString() : null,
        remainingPercentage: Math.max(0, 100 - usedPercent),
        unlimited: false,
      };
    }

    const levelRaw = typeof data.level === "string" ? data.level : "";
    const plan = levelRaw
      ? levelRaw.charAt(0).toUpperCase() + levelRaw.slice(1).toLowerCase()
      : "Unknown";

    return { plan, quotas };
  } catch (error) {
    return { message: `GLM error: ${error.message}` };
  }
}
