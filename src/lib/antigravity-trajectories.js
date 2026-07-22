/**
 * Antigravity Trajectory RPC — fetches exact (bill-level) token usage from the
 * locally-running Antigravity language server via Connect-RPC.
 *
 * Flow:
 *  1. Detect the Antigravity process (reuses detectAntigravityProcess)
 *  2. Discover listening ports and probe for a working one
 *  3. Call GetAllCascadeTrajectories → list of active conversations
 *  4. Call GetCascadeTrajectorySteps per trajectory → steps with checkpoints
 *  5. Extract modelUsage from CORTEX_STEP_TYPE_CHECKPOINT steps
 *
 * The returned events carry exact inputTokens/outputTokens reported by the
 * model service, unlike the transcript.jsonl parser which estimates from
 * character counts.
 */
"use strict";

const {
  detectAntigravityProcess,
  listAntigravityPorts,
  probeAntigravityPort,
  requestLocalJson,
  antigravityDefaultBody,
} = require("./usage-limits");

const RPC_SERVICE = "/exa.language_server_pb.LanguageServerService";

// ─── Connection ────────────────────────────────────────────────────────────────

/**
 * Establish a connection to the local Antigravity server.
 * Returns { port, scheme, csrfToken } or null if unavailable.
 */
async function connectAntigravityServer({
  commandRunner,
  requestFn,
  timeoutMs = 8000,
  platform = process.platform,
} = {}) {
  const processInfo = await detectAntigravityProcess({ commandRunner, platform });
  if (!processInfo.configured || processInfo.error) return null;

  const ports = await listAntigravityPorts(processInfo.pid, { commandRunner, platform });
  for (const port of ports) {
    if (await probeAntigravityPort(port, processInfo.csrfToken, { timeoutMs, requestFn })) {
      return { port, scheme: "https", csrfToken: processInfo.csrfToken };
    }
    // agy CLI serves HTTP without CSRF
    if (!processInfo.csrfToken) {
      if (await probeAntigravityPort(port, null, { timeoutMs, requestFn, scheme: "http" })) {
        return { port, scheme: "http", csrfToken: null };
      }
    }
  }
  return null;
}

// ─── RPC Calls ─────────────────────────────────────────────────────────────────

/**
 * Fetch all active cascade trajectories (conversations) from the server.
 * Returns an array of { cascadeId, model, stepCount }.
 */
async function getAllCascadeTrajectories({ port, scheme, csrfToken, timeoutMs, requestFn }) {
  const body = { ...antigravityDefaultBody() };
  const response = await requestLocalJson({
    scheme,
    port,
    path: `${RPC_SERVICE}/GetAllCascadeTrajectories`,
    body,
    csrfToken,
    timeoutMs,
    requestFn,
  });

  const trajectories = response?.trajectories || response?.cascadeTrajectories || [];
  return trajectories.map((t) => ({
    cascadeId: t.cascadeId || t.cascade_id || t.id || "",
    model: t.model || t.modelName || t.model_name || null,
    stepCount: Number(t.stepCount || t.step_count || 0),
  })).filter((t) => t.cascadeId);
}

/**
 * Fetch steps for a specific trajectory.
 * Returns the raw steps array from the response.
 */
async function getCascadeTrajectorySteps({ port, scheme, csrfToken, timeoutMs, requestFn, cascadeId }) {
  const body = {
    ...antigravityDefaultBody(),
    cascadeId,
  };
  const response = await requestLocalJson({
    scheme,
    port,
    path: `${RPC_SERVICE}/GetCascadeTrajectorySteps`,
    body,
    csrfToken,
    timeoutMs,
    requestFn,
  });

  return response?.steps || response?.trajectorySteps || [];
}

// ─── Checkpoint Extraction ─────────────────────────────────────────────────────

const CHECKPOINT_STEP_TYPE = "CORTEX_STEP_TYPE_CHECKPOINT";

/**
 * Determine if a step is a checkpoint containing modelUsage.
 */
function isCheckpointStep(step) {
  if (!step || typeof step !== "object") return false;
  const stepType = step.stepType || step.step_type || step.type || "";
  return stepType === CHECKPOINT_STEP_TYPE;
}

/**
 * Extract modelUsage from a checkpoint step's payload.
 * Returns { inputTokens, outputTokens } or null.
 */
function extractModelUsage(step) {
  if (!step || typeof step !== "object") return null;
  // modelUsage may be at various nesting levels depending on server version
  const payload = step.payload || step.stepPayload || step;
  const usage = payload.modelUsage || payload.model_usage || null;
  if (!usage) return null;

  const inputTokens = Number(usage.inputTokens || usage.input_tokens || 0);
  const outputTokens = Number(usage.outputTokens || usage.output_tokens || 0);
  if (inputTokens <= 0 && outputTokens <= 0) return null;

  return { inputTokens, outputTokens };
}

/**
 * Extract a timestamp from a step. Tries multiple field names.
 * Returns an ISO string or null.
 */
function extractStepTimestamp(step) {
  if (!step || typeof step !== "object") return null;
  const raw = step.createdAt || step.created_at || step.timestamp || step.endTime || step.end_time || null;
  if (!raw) return null;
  // Handle protobuf Timestamp {seconds, nanos} or epoch millis or ISO string
  if (typeof raw === "object" && raw.seconds != null) {
    const ms = Number(raw.seconds) * 1000 + Math.floor(Number(raw.nanos || 0) / 1e6);
    return new Date(ms).toISOString();
  }
  if (typeof raw === "number") {
    // Heuristic: if > 1e12 it's millis, otherwise seconds
    const ms = raw > 1e12 ? raw : raw * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof raw === "string") {
    const d = new Date(raw);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  return null;
}

/**
 * Extract the model name from a step or trajectory.
 */
function extractStepModel(step, trajectoryModel) {
  const stepModel = step.model || step.modelName || step.model_name || null;
  return stepModel || trajectoryModel || null;
}

// ─── Main Entry ────────────────────────────────────────────────────────────────

/**
 * Fetch exact token usage events from the local Antigravity server via
 * Trajectory RPC.
 *
 * @param {object} opts
 * @param {object} opts.cursors - Mutable cursor object; trajectory state stored
 *   under opts.cursors.antigravityTrajectories
 * @param {function} [opts.commandRunner] - Custom command runner (for tests)
 * @param {function} [opts.requestFn] - Custom request function (for tests)
 * @param {number} [opts.timeoutMs=8000]
 * @param {string} [opts.platform]
 * @returns {Promise<{available: boolean, events: Array, error: string|null}>}
 *   events: [{cascadeId, stepIndex, timestamp, model, inputTokens, outputTokens}]
 */
async function fetchAntigravityTrajectoryUsage({
  cursors,
  commandRunner,
  requestFn,
  timeoutMs = 8000,
  platform = process.platform,
} = {}) {
  try {
    const conn = await connectAntigravityServer({ commandRunner, requestFn, timeoutMs, platform });
    if (!conn) {
      return { available: false, events: [], error: null };
    }

    const trajectories = await getAllCascadeTrajectories({ ...conn, timeoutMs, requestFn });
    if (!trajectories.length) {
      return { available: true, events: [], error: null };
    }

    // Load cursor state for dedup
    if (!cursors) cursors = {};
    if (!cursors.antigravityTrajectories || typeof cursors.antigravityTrajectories !== "object") {
      cursors.antigravityTrajectories = {};
    }
    const trajCursors = cursors.antigravityTrajectories;
    const events = [];

    for (const traj of trajectories) {
      const prevCursor = trajCursors[traj.cascadeId] || null;
      const prevStepCount = prevCursor?.stepCount || 0;

      // Skip trajectories with no new steps
      if (traj.stepCount > 0 && traj.stepCount <= prevStepCount) {
        continue;
      }

      let steps;
      try {
        steps = await getCascadeTrajectorySteps({
          ...conn,
          timeoutMs,
          requestFn,
          cascadeId: traj.cascadeId,
        });
      } catch (_stepError) {
        // Individual trajectory fetch failure shouldn't abort the whole sync
        continue;
      }

      if (!Array.isArray(steps) || steps.length === 0) continue;

      const startIdx = prevCursor?.lastStepIndex != null ? prevCursor.lastStepIndex + 1 : 0;
      let lastProcessedIndex = prevCursor?.lastStepIndex ?? -1;

      for (let i = startIdx; i < steps.length; i++) {
        const step = steps[i];
        if (!isCheckpointStep(step)) continue;

        const usage = extractModelUsage(step);
        if (!usage) continue;

        const timestamp = extractStepTimestamp(step);
        const model = extractStepModel(step, traj.model);

        events.push({
          cascadeId: traj.cascadeId,
          stepIndex: i,
          timestamp,
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
        lastProcessedIndex = i;
      }

      // Update cursor for this trajectory
      trajCursors[traj.cascadeId] = {
        stepCount: traj.stepCount,
        lastStepIndex: Math.max(lastProcessedIndex, steps.length - 1),
        model: traj.model,
        updatedAt: new Date().toISOString(),
      };
    }

    // Prune cursors for trajectories no longer reported by the server
    const activeIds = new Set(trajectories.map((t) => t.cascadeId));
    for (const key of Object.keys(trajCursors)) {
      if (!activeIds.has(key)) {
        delete trajCursors[key];
      }
    }

    return { available: true, events, error: null };
  } catch (error) {
    return {
      available: false,
      events: [],
      error: error?.message || "Unknown trajectory fetch error",
    };
  }
}

module.exports = {
  connectAntigravityServer,
  getAllCascadeTrajectories,
  getCascadeTrajectorySteps,
  isCheckpointStep,
  extractModelUsage,
  extractStepTimestamp,
  extractStepModel,
  fetchAntigravityTrajectoryUsage,
  CHECKPOINT_STEP_TYPE,
};
