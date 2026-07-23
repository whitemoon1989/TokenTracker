import { describe, expect, it } from "vitest";
import { buildFleetData } from "./model-breakdown";

describe("buildFleetData", () => {
  it("keeps two decimal places for small provider percentages", () => {
    const fleet = buildFleetData({
      sources: [
        {
          source: "claude",
          totals: { billable_total_tokens: 999_600 },
          models: [{ model_id: "claude-sonnet", totals: { billable_total_tokens: 999_600 } }],
        },
        {
          source: "antigravity",
          totals: { billable_total_tokens: 400 },
          models: [{ model_id: "gemini-pro", totals: { billable_total_tokens: 400 } }],
        },
        {
          source: "grok",
          totals: { billable_total_tokens: 1 },
          models: [{ model_id: "grok-code", totals: { billable_total_tokens: 1 } }],
        },
      ],
    });

    expect(fleet.map(({ source, totalPercent }) => [source, totalPercent])).toEqual([
      ["claude", "99.96"],
      ["antigravity", "0.04"],
      ["grok", "0.00"],
    ]);
    expect(fleet[2].totalPercentValue).toBeGreaterThan(0);
    expect(fleet[2].totalPercentValue).toBeLessThan(0.01);
  });

  it("aggregates usage by model across multiple sources when groupBy is model", () => {
    const fleet = buildFleetData(
      {
        sources: [
          {
            source: "codebuddy",
            totals: { total_cost_usd: 0.06 },
            models: [
              {
                model_id: "deepseek-v4-flash",
                model: "deepseek-v4-flash",
                totals: { billable_total_tokens: 2_000_000, total_cost_usd: 0.02 },
              },
              {
                model_id: "deepseek-v4-pro",
                model: "deepseek-v4-pro",
                totals: { billable_total_tokens: 1_000_000, total_cost_usd: 0.04 },
              },
            ],
          },
          {
            source: "antigravity",
            totals: { total_cost_usd: 0.01 },
            models: [
              {
                model_id: "deepseek-v4-flash",
                model: "deepseek-v4-flash",
                totals: { billable_total_tokens: 1_000_000, total_cost_usd: 0.01 },
              },
            ],
          },
        ],
      },
      { groupBy: "model" }
    );

    expect(fleet.length).toBe(2);
    // Highest usage first: deepseek-v4-flash (3M tokens = 75%)
    expect(fleet[0].source).toBe("deepseek-v4-flash");
    expect(fleet[0].usage).toBe(3_000_000);
    expect(fleet[0].totalPercent).toBe("75.00");
    expect(fleet[0].sourceCount).toBe(2);
    expect(fleet[0].models).toEqual([
      expect.objectContaining({ source: "codebuddy", usage: 2_000_000 }),
      expect.objectContaining({ source: "antigravity", usage: 1_000_000 }),
    ]);

    // Second: deepseek-v4-pro (1M tokens = 25%)
    expect(fleet[1].source).toBe("deepseek-v4-pro");
    expect(fleet[1].usage).toBe(1_000_000);
    expect(fleet[1].totalPercent).toBe("25.00");
    expect(fleet[1].sourceCount).toBe(1);
  });
});
