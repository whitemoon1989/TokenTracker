import { toFiniteNumber } from "./format";

type AnyRecord = Record<string, any>;

// Sources that only report aggregate input/output tokens without a cache
// breakdown. We estimate 90% of input tokens are cache hits for display.
const ESTIMATED_CACHE_HIT_RATE = 0.9;
const ESTIMATED_CACHE_SOURCES = new Set(["antigravity", "grok"]);

function normalizeModelId(value: any) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

function resolveModelId(model: any) {
  const id = normalizeModelId(model?.model_id);
  if (id) return id;
  return null;
}

function resolveModelName(model: any, fallback: any) {
  if (model?.model) return String(model.model);
  return fallback;
}

export function resolveDisplayTokens(totals: any, fallback = 0) {
  const billableTokens = toFiniteNumber(totals?.billable_total_tokens);
  const totalTokens = toFiniteNumber(totals?.total_tokens);
  if (billableTokens != null && billableTokens > 0) return billableTokens;
  if (totalTokens != null && totalTokens > 0) return totalTokens;
  return billableTokens ?? totalTokens ?? fallback;
}

export function buildModelGroupedFleetData(modelBreakdown: any, { copyFn }: AnyRecord = {}) {
  const safeCopy = typeof copyFn === "function" ? copyFn : (key: string) => key;
  const sources: any[] = Array.isArray(modelBreakdown?.sources) ? modelBreakdown.sources : [];
  if (!sources.length) return [];

  const modelsMap = new Map<string, any>();

  for (const entry of sources) {
    const sourceKey = String(entry?.source || "").toLowerCase();
    const sourceTotalTokens = resolveDisplayTokens(entry?.totals) ?? 0;
    const sourceTotalCost = toFiniteNumber(entry?.totals?.total_cost_usd) ?? 0;
    const modelsList: any[] = Array.isArray(entry?.models) ? entry.models : [];

    const rawSourceCacheRead = Math.max(0, toFiniteNumber(entry?.totals?.cached_input_tokens) ?? 0);
    const rawSourceCacheCreate = Math.max(0, toFiniteNumber(entry?.totals?.cache_creation_input_tokens) ?? 0);
    const useEstimate =
      rawSourceCacheRead + rawSourceCacheCreate === 0 && ESTIMATED_CACHE_SOURCES.has(sourceKey);

    for (const model of modelsList) {
      const rawModelTokens = resolveDisplayTokens(model?.totals);
      if (!Number.isFinite(rawModelTokens) || rawModelTokens <= 0) continue;

      const rawModelInput = Math.max(0, toFiniteNumber(model?.totals?.input_tokens) ?? 0);
      const rawModelCached = Math.max(0, toFiniteNumber(model?.totals?.cached_input_tokens) ?? 0);
      const rawModelCacheCreate = Math.max(0, toFiniteNumber(model?.totals?.cache_creation_input_tokens) ?? 0);

      const modelUseEstimate = useEstimate && rawModelCached + rawModelCacheCreate === 0;
      const modelInferredCached = modelUseEstimate
        ? Math.round(rawModelInput * (ESTIMATED_CACHE_HIT_RATE / (1 - ESTIMATED_CACHE_HIT_RATE)))
        : 0;

      const modelTokens = rawModelTokens + modelInferredCached;
      const name = resolveModelName(model, safeCopy("shared.placeholder.short"));
      const id = resolveModelId(model) || normalizeModelId(name) || name;
      const key = id.toLowerCase();

      const explicitModelCost = toFiniteNumber(model?.totals?.total_cost_usd);
      const modelCost =
        explicitModelCost != null
          ? explicitModelCost
          : sourceTotalCost > 0 && sourceTotalTokens > 0
            ? (modelTokens / sourceTotalTokens) * sourceTotalCost
            : 0;

      const output =
        Math.max(0, toFiniteNumber(model?.totals?.output_tokens) ?? 0) +
        Math.max(0, toFiniteNumber(model?.totals?.reasoning_output_tokens) ?? 0);
      const cached = modelUseEstimate ? modelInferredCached : rawModelCached;

      let modelAgg = modelsMap.get(key);
      if (!modelAgg) {
        modelAgg = {
          id,
          name,
          totalTokens: 0,
          totalCost: 0,
          rawInput: 0,
          rawCacheRead: 0,
          rawCacheCreate: 0,
          rawOutput: 0,
          sourcesMap: new Map(),
        };
        modelsMap.set(key, modelAgg);
      }

      modelAgg.totalTokens += modelTokens;
      modelAgg.totalCost += modelCost;
      modelAgg.rawInput += rawModelInput;
      modelAgg.rawCacheRead += cached;
      modelAgg.rawCacheCreate += rawModelCacheCreate;
      modelAgg.rawOutput += output;

      let srcAgg = modelAgg.sourcesMap.get(sourceKey);
      if (!srcAgg) {
        srcAgg = {
          source: entry.source || sourceKey,
          tokens: 0,
          cost: 0,
          rawInput: 0,
          rawOutput: 0,
          rawCached: 0,
          rawCacheCreate: 0,
        };
        modelAgg.sourcesMap.set(sourceKey, srcAgg);
      }

      srcAgg.tokens += modelTokens;
      srcAgg.cost = (srcAgg.cost ?? 0) + modelCost;
      srcAgg.rawInput += rawModelInput;
      srcAgg.rawOutput += output;
      srcAgg.rawCached += cached;
      srcAgg.rawCacheCreate += rawModelCacheCreate;
    }
  }

  const grandTotal = Array.from(modelsMap.values()).reduce((acc: number, entry: any) => acc + entry.totalTokens, 0);
  if (!grandTotal || !modelsMap.size) return [];

  return Array.from(modelsMap.values())
    .slice()
    .sort((a: any, b: any) => b.totalTokens - a.totalTokens)
    .map((item: any) => {
      const totalPercentRaw = grandTotal > 0 ? (item.totalTokens / grandTotal) * 100 : 0;
      const totalPercent = Number.isFinite(totalPercentRaw) ? totalPercentRaw.toFixed(2) : "0.00";

      const cacheInputTokens = item.rawInput + item.rawCacheRead + item.rawCacheCreate;
      const hasCacheActivity = item.rawCacheRead + item.rawCacheCreate > 0;
      const cacheHitRate =
        hasCacheActivity && cacheInputTokens > 0
          ? Math.round((item.rawCacheRead / cacheInputTokens) * 100)
          : null;

      const modelSources = Array.from(item.sourcesMap.values())
        .slice()
        .sort((a: any, b: any) => b.tokens - a.tokens)
        .map((src: any) => {
          const share =
            item.totalTokens > 0 ? Math.round((src.tokens / item.totalTokens) * 1000) / 10 : 0;
          return {
            id: src.source,
            name: String(src.source).toUpperCase(),
            source: src.source,
            share,
            usage: src.tokens,
            cost: src.cost,
            breakdown: {
              input: src.rawInput,
              output: src.rawOutput,
              cached: src.rawCached,
              cacheCreate: src.rawCacheCreate,
            },
          };
        });

      return {
        source: item.id,
        label: item.name,
        totalPercent: String(totalPercent),
        totalPercentValue: totalPercentRaw,
        usd: item.totalCost,
        usage: item.totalTokens,
        cacheHitRate,
        cacheReusedTokens: item.rawCacheRead,
        sourceCount: item.sourcesMap.size,
        models: modelSources,
      };
    });
}

export function buildFleetData(modelBreakdown: any, { copyFn, groupBy = "provider" }: AnyRecord = {}) {
  if (groupBy === "model") {
    return buildModelGroupedFleetData(modelBreakdown, { copyFn });
  }
  const safeCopy = typeof copyFn === "function" ? copyFn : (key: string) => key;
  const sources: any[] = Array.isArray(modelBreakdown?.sources) ? modelBreakdown.sources : [];
  const normalizedSources = sources
    .map((entry: any) => {
      const totalTokens = resolveDisplayTokens(entry?.totals);
      const totalCost = toFiniteNumber(entry?.totals?.total_cost_usd) ?? 0;
      const rawInput = Math.max(0, toFiniteNumber(entry?.totals?.input_tokens) ?? 0);
      const rawCacheRead = Math.max(0, toFiniteNumber(entry?.totals?.cached_input_tokens) ?? 0);
      const rawCacheCreate = Math.max(0, toFiniteNumber(entry?.totals?.cache_creation_input_tokens) ?? 0);
      // input_tokens is the cache-MISS portion. Infer cached tokens from the
      // estimated 90% hit rate: cached = input * (0.9 / 0.1) = input * 9.
      const sourceKey = String(entry?.source || "").toLowerCase();
      const useEstimate =
        rawCacheRead + rawCacheCreate === 0 && ESTIMATED_CACHE_SOURCES.has(sourceKey);
      const inferredCached = useEstimate
        ? Math.round(rawInput * (ESTIMATED_CACHE_HIT_RATE / (1 - ESTIMATED_CACHE_HIT_RATE)))
        : 0;
      return {
        source: entry?.source,
        totalTokens: (Number.isFinite(totalTokens) ? totalTokens : 0) + inferredCached,
        totalCost: Number.isFinite(totalCost) ? totalCost : 0,
        inputTokens: rawInput,
        cacheRead: useEstimate ? inferredCached : rawCacheRead,
        cacheCreate: rawCacheCreate,
        estimatedCache: useEstimate,
        models: Array.isArray(entry?.models) ? entry.models : [],
      };
    })
    .filter((entry) => entry.totalTokens > 0);

  if (!normalizedSources.length) return [];

  const grandTotal = normalizedSources.reduce((acc, entry) => acc + entry.totalTokens, 0);
  const pricingMode =
    typeof modelBreakdown?.pricing?.pricing_mode === "string"
      ? modelBreakdown.pricing.pricing_mode.toUpperCase()
      : null;

  return normalizedSources
    .slice()
    .sort((a: any, b: any) => b.totalTokens - a.totalTokens)
    .map((entry: any) => {
      const label = entry.source
        ? String(entry.source).toUpperCase()
        : safeCopy("shared.placeholder.short");
      const totalPercentRaw = grandTotal > 0 ? (entry.totalTokens / grandTotal) * 100 : 0;
      const totalPercent = Number.isFinite(totalPercentRaw) ? totalPercentRaw.toFixed(2) : "0.00";
      const models = entry.models
        .map((model: any) => {
          const rawModelTokens = resolveDisplayTokens(model?.totals);
          if (!Number.isFinite(rawModelTokens) || rawModelTokens <= 0) return null;
          // Token-type split for the stacked composition bar. Output includes
          // reasoning tokens (both are output-side); "input" here is the
          // cache-miss portion. For estimated sources, cached is inferred.
          const rawModelInput = Math.max(0, toFiniteNumber(model?.totals?.input_tokens) ?? 0);
          const rawModelCached = Math.max(0, toFiniteNumber(model?.totals?.cached_input_tokens) ?? 0);
          const rawModelCacheCreate = Math.max(0, toFiniteNumber(model?.totals?.cache_creation_input_tokens) ?? 0);
          const modelUseEstimate =
            entry.estimatedCache && rawModelCached + rawModelCacheCreate === 0;
          const modelInferredCached = modelUseEstimate
            ? Math.round(rawModelInput * (ESTIMATED_CACHE_HIT_RATE / (1 - ESTIMATED_CACHE_HIT_RATE)))
            : 0;
          const modelTokens = rawModelTokens + modelInferredCached;
          const share =
            entry.totalTokens > 0 ? Math.round((modelTokens / entry.totalTokens) * 1000) / 10 : 0;
          const name = resolveModelName(model, safeCopy("shared.placeholder.short"));
          const id = resolveModelId(model);
          const explicitModelCost = toFiniteNumber(model?.totals?.total_cost_usd);
          const modelCost =
            explicitModelCost != null
              ? explicitModelCost
              : entry.totalCost > 0 && entry.totalTokens > 0
                ? (modelTokens / entry.totalTokens) * entry.totalCost
                : null;
          const breakdown = {
            input: rawModelInput,
            output:
              Math.max(0, toFiniteNumber(model?.totals?.output_tokens) ?? 0) +
              Math.max(0, toFiniteNumber(model?.totals?.reasoning_output_tokens) ?? 0),
            cached: modelUseEstimate ? modelInferredCached : rawModelCached,
            cacheCreate: rawModelCacheCreate,
          };
          return { id, name, share, usage: modelTokens, cost: modelCost, breakdown };
        })
        .filter(Boolean);
      // Input-side cache hit rate = cache reads / all input-side tokens
      // (non-cached input + cache reads + cache writes). cached_input_tokens are
      // reads, cache_creation_input_tokens are writes. For sources that report no
      // cache split (antigravity/grok), the normalized values already reflect the
      // 90% estimated hit rate. null only for sources with zero input tokens.
      const cacheInputTokens = entry.inputTokens + entry.cacheRead + entry.cacheCreate;
      const hasCacheActivity = entry.cacheRead + entry.cacheCreate > 0;
      const cacheHitRate =
        hasCacheActivity && cacheInputTokens > 0
          ? Math.round((entry.cacheRead / cacheInputTokens) * 100)
          : null;
      return {
        source: entry.source,
        label,
        totalPercent: String(totalPercent),
        totalPercentValue: totalPercentRaw,
        usd: entry.totalCost,
        usage: entry.totalTokens,
        cacheHitRate,
        cacheReusedTokens: entry.cacheRead,
        cacheInputTokens,
        sourceCount: models.length,
        models,
      };
    });
}

export function buildTopModels(modelBreakdown: any, { limit = 3, copyFn }: AnyRecord = {}) {
  const safeCopy = typeof copyFn === "function" ? copyFn : (key: string) => key;
  const sources: any[] = Array.isArray(modelBreakdown?.sources) ? modelBreakdown.sources : [];
  if (!sources.length) return [];

  const totalsByKey = new Map();
  const nameByKey = new Map();
  const nameWeight = new Map();
  let totalTokensAll = 0;

  for (const source of sources) {
    const models: any[] = Array.isArray(source?.models) ? source.models : [];
    for (const model of models) {
      const tokens = resolveDisplayTokens(model?.totals);
      if (!Number.isFinite(tokens) || tokens <= 0) continue;
      totalTokensAll += tokens;
      const name = resolveModelName(model, safeCopy("shared.placeholder.short"));
      const key = normalizeModelId(name);
      if (!key) continue;
      totalsByKey.set(key, (totalsByKey.get(key) || 0) + tokens);
      const currentWeight = nameWeight.get(key) || 0;
      if (tokens >= currentWeight) {
        nameWeight.set(key, tokens);
        nameByKey.set(key, name);
      }
    }
  }

  if (!totalsByKey.size) return [];

  const knownTotal = Array.from(totalsByKey.values()).reduce((acc, value) => acc + value, 0);
  const totalTokens = totalTokensAll > 0 ? totalTokensAll : knownTotal;

  const normalizedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 3;
  return Array.from(totalsByKey.entries())
    .map(([key, tokens]) => {
      const percent = totalTokens > 0 ? ((tokens / totalTokens) * 100).toFixed(1) : "0.0";
      return {
        id: key,
        name: nameByKey.get(key) || safeCopy("shared.placeholder.short"),
        tokens,
        percent: String(percent),
      };
    })
    .sort((a, b) => {
      if (b.tokens !== a.tokens) return b.tokens - a.tokens;
      return String(a.name).localeCompare(String(b.name));
    })
    .slice(0, normalizedLimit);
}
