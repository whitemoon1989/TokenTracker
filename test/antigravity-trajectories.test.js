const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  isCheckpointStep,
  extractModelUsage,
  extractStepTimestamp,
  extractStepModel,
  fetchAntigravityTrajectoryUsage,
  CHECKPOINT_STEP_TYPE,
} = require("../src/lib/antigravity-trajectories");

const {
  parseAntigravityTrajectoryEvents,
} = require("../src/lib/rollout");

// ─── isCheckpointStep ──────────────────────────────────────────────────────────

describe("isCheckpointStep", () => {
  it("returns true for CORTEX_STEP_TYPE_CHECKPOINT", () => {
    assert.equal(isCheckpointStep({ stepType: CHECKPOINT_STEP_TYPE }), true);
    assert.equal(isCheckpointStep({ step_type: CHECKPOINT_STEP_TYPE }), true);
    assert.equal(isCheckpointStep({ type: CHECKPOINT_STEP_TYPE }), true);
  });

  it("returns false for other step types", () => {
    assert.equal(isCheckpointStep({ stepType: "CORTEX_STEP_TYPE_PLANNER" }), false);
    assert.equal(isCheckpointStep({}), false);
    assert.equal(isCheckpointStep(null), false);
  });
});

// ─── extractModelUsage ─────────────────────────────────────────────────────────

describe("extractModelUsage", () => {
  it("extracts from payload.modelUsage (camelCase)", () => {
    const step = { payload: { modelUsage: { inputTokens: 14502, outputTokens: 843 } } };
    assert.deepEqual(extractModelUsage(step), { inputTokens: 14502, outputTokens: 843 });
  });

  it("extracts from payload.model_usage (snake_case)", () => {
    const step = { payload: { model_usage: { input_tokens: 100, output_tokens: 50 } } };
    assert.deepEqual(extractModelUsage(step), { inputTokens: 100, outputTokens: 50 });
  });

  it("extracts from stepPayload nesting", () => {
    const step = { stepPayload: { modelUsage: { inputTokens: 200, outputTokens: 300 } } };
    assert.deepEqual(extractModelUsage(step), { inputTokens: 200, outputTokens: 300 });
  });

  it("extracts from top-level modelUsage", () => {
    const step = { modelUsage: { inputTokens: 500, outputTokens: 100 } };
    assert.deepEqual(extractModelUsage(step), { inputTokens: 500, outputTokens: 100 });
  });

  it("returns null when no usage present", () => {
    assert.equal(extractModelUsage({ payload: {} }), null);
    assert.equal(extractModelUsage({}), null);
    assert.equal(extractModelUsage(null), null);
  });

  it("returns null when both tokens are zero", () => {
    const step = { payload: { modelUsage: { inputTokens: 0, outputTokens: 0 } } };
    assert.equal(extractModelUsage(step), null);
  });
});

// ─── extractStepTimestamp ──────────────────────────────────────────────────────

describe("extractStepTimestamp", () => {
  it("handles ISO string", () => {
    const result = extractStepTimestamp({ createdAt: "2026-07-22T10:30:00.000Z" });
    assert.equal(result, "2026-07-22T10:30:00.000Z");
  });

  it("handles protobuf Timestamp {seconds, nanos}", () => {
    const result = extractStepTimestamp({ created_at: { seconds: 1753178400, nanos: 500000000 } });
    const d = new Date(result);
    assert.equal(d.getUTCFullYear(), 2025);
    assert.ok(Number.isFinite(d.getTime()));
  });

  it("handles epoch milliseconds", () => {
    const ms = Date.UTC(2026, 6, 22, 10, 0, 0);
    const result = extractStepTimestamp({ timestamp: ms });
    assert.equal(result, new Date(ms).toISOString());
  });

  it("handles epoch seconds", () => {
    const sec = Math.floor(Date.UTC(2026, 6, 22, 10, 0, 0) / 1000);
    const result = extractStepTimestamp({ timestamp: sec });
    assert.equal(result, new Date(sec * 1000).toISOString());
  });

  it("returns null for missing timestamp", () => {
    assert.equal(extractStepTimestamp({}), null);
    assert.equal(extractStepTimestamp(null), null);
  });
});

// ─── extractStepModel ──────────────────────────────────────────────────────────

describe("extractStepModel", () => {
  it("prefers step-level model", () => {
    assert.equal(extractStepModel({ model: "claude-sonnet-4" }, "gemini-2.5-pro"), "claude-sonnet-4");
  });

  it("falls back to trajectory model", () => {
    assert.equal(extractStepModel({}, "gemini-2.5-pro"), "gemini-2.5-pro");
  });

  it("returns null when neither present", () => {
    assert.equal(extractStepModel({}, null), null);
  });
});

// ─── fetchAntigravityTrajectoryUsage ───────────────────────────────────────────

describe("fetchAntigravityTrajectoryUsage", () => {
  it("returns available:false when no process detected", async () => {
    const result = await fetchAntigravityTrajectoryUsage({
      cursors: {},
      commandRunner: () => ({ status: 1, stdout: "", stderr: "" }),
      platform: "win32",
    });
    assert.equal(result.available, false);
    assert.deepEqual(result.events, []);
  });

  it("fetches and deduplicates checkpoint events via mocked RPC", async () => {
    const trajectoriesResponse = {
      trajectories: [
        { cascadeId: "conv-1", model: "claude-sonnet-4", stepCount: 5 },
      ],
    };
    const stepsResponse = {
      steps: [
        { stepType: "CORTEX_STEP_TYPE_PLANNER", createdAt: "2026-07-22T09:00:00Z" },
        {
          stepType: CHECKPOINT_STEP_TYPE,
          createdAt: "2026-07-22T09:01:00Z",
          payload: { modelUsage: { inputTokens: 1000, outputTokens: 200 } },
        },
        { stepType: "CORTEX_STEP_TYPE_PLANNER", createdAt: "2026-07-22T09:02:00Z" },
        {
          stepType: CHECKPOINT_STEP_TYPE,
          createdAt: "2026-07-22T09:03:00Z",
          payload: { modelUsage: { inputTokens: 2000, outputTokens: 400 } },
        },
      ],
    };

    // Mock commandRunner for win32: wmic for process detection, netstat for ports
    const commandRunner = (cmd, args) => {
      if (cmd === "wmic") {
        return {
          status: 0,
          stdout: 'Node,Caption,ProcessId\nHOST,"C:\\Users\\me\\agy.exe --standalone --csrf_token abc123",12345\n',
        };
      }
      if (cmd === "netstat") {
        return {
          status: 0,
          stdout: "  TCP    127.0.0.1:9999         0.0.0.0:0              LISTENING       12345\n",
        };
      }
      return { status: 1, stdout: "", stderr: "" };
    };

    // Mock requestFn: route by path
    const requestFn = ({ path: rpcPath }) => {
      if (rpcPath.includes("GetUnleashData")) return Promise.resolve({});
      if (rpcPath.includes("GetAllCascadeTrajectories")) return Promise.resolve(trajectoriesResponse);
      if (rpcPath.includes("GetCascadeTrajectorySteps")) return Promise.resolve(stepsResponse);
      return Promise.reject(new Error(`unexpected path: ${rpcPath}`));
    };

    const cursors = {};
    const result = await fetchAntigravityTrajectoryUsage({
      cursors,
      commandRunner,
      requestFn,
      platform: "win32",
    });

    assert.equal(result.available, true);
    assert.equal(result.error, null);
    assert.equal(result.events.length, 2);
    assert.deepEqual(result.events[0], {
      cascadeId: "conv-1",
      stepIndex: 1,
      timestamp: "2026-07-22T09:01:00.000Z",
      model: "claude-sonnet-4",
      inputTokens: 1000,
      outputTokens: 200,
    });
    assert.deepEqual(result.events[1], {
      cascadeId: "conv-1",
      stepIndex: 3,
      timestamp: "2026-07-22T09:03:00.000Z",
      model: "claude-sonnet-4",
      inputTokens: 2000,
      outputTokens: 400,
    });

    // Cursor should be updated
    assert.ok(cursors.antigravityTrajectories["conv-1"]);
    assert.equal(cursors.antigravityTrajectories["conv-1"].stepCount, 5);
  });

  it("skips already-seen trajectories on second call", async () => {
    const trajectoriesResponse = {
      trajectories: [
        { cascadeId: "conv-1", model: "gemini-2.5-pro", stepCount: 3 },
      ],
    };
    const stepsResponse = {
      steps: [
        {
          stepType: CHECKPOINT_STEP_TYPE,
          createdAt: "2026-07-22T10:00:00Z",
          payload: { modelUsage: { inputTokens: 500, outputTokens: 100 } },
        },
      ],
    };

    const commandRunner = (cmd) => {
      if (cmd === "wmic") {
        return {
          status: 0,
          stdout: 'Node,Caption,ProcessId\nHOST,"C:\\agy.exe --standalone",999\n',
        };
      }
      if (cmd === "netstat") {
        return {
          status: 0,
          stdout: "  TCP    127.0.0.1:8888         0.0.0.0:0              LISTENING       999\n",
        };
      }
      return { status: 1, stdout: "", stderr: "" };
    };

    const requestFn = ({ path: rpcPath }) => {
      if (rpcPath.includes("GetUnleashData")) return Promise.resolve({});
      if (rpcPath.includes("GetAllCascadeTrajectories")) return Promise.resolve(trajectoriesResponse);
      if (rpcPath.includes("GetCascadeTrajectorySteps")) return Promise.resolve(stepsResponse);
      return Promise.reject(new Error(`unexpected: ${rpcPath}`));
    };

    const cursors = {};
    // First call: should get 1 event
    const r1 = await fetchAntigravityTrajectoryUsage({ cursors, commandRunner, requestFn, platform: "win32" });
    assert.equal(r1.events.length, 1);

    // Second call with same stepCount: should skip (no new steps)
    const r2 = await fetchAntigravityTrajectoryUsage({ cursors, commandRunner, requestFn, platform: "win32" });
    assert.equal(r2.available, true);
    assert.equal(r2.events.length, 0);
  });
});

// ─── parseAntigravityTrajectoryEvents ──────────────────────────────────────────

describe("parseAntigravityTrajectoryEvents", () => {
  it("aggregates events into hourly buckets and writes queue", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-traj-test-"));
    try {
      const queuePath = path.join(tmp, "queue.jsonl");
      const cursors = {};
      const events = [
        { timestamp: "2026-07-22T10:05:00Z", model: "claude-sonnet-4", inputTokens: 1000, outputTokens: 200 },
        { timestamp: "2026-07-22T10:20:00Z", model: "claude-sonnet-4", inputTokens: 2000, outputTokens: 400 },
        { timestamp: "2026-07-22T11:10:00Z", model: "gemini-2.5-pro", inputTokens: 500, outputTokens: 100 },
      ];

      const result = await parseAntigravityTrajectoryEvents({
        events,
        cursors,
        queuePath,
        source: "antigravity",
      });

      assert.equal(result.eventsAggregated, 3);
      assert.ok(result.bucketsQueued > 0);

      // Verify queue file was written
      const content = fs.readFileSync(queuePath, "utf8").trim();
      const rows = content.split("\n").map((l) => JSON.parse(l));
      assert.ok(rows.length >= 1);

      // Check that totals are correct across all rows
      const totalInput = rows.reduce((s, r) => s + (r.input_tokens || 0), 0);
      const totalOutput = rows.reduce((s, r) => s + (r.output_tokens || 0), 0);
      assert.equal(totalInput, 3500);
      assert.equal(totalOutput, 700);

      // Cursors should have hourly state
      assert.ok(cursors.hourly);
      assert.ok(cursors.hourly.buckets);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns zeros for empty events", async () => {
    const result = await parseAntigravityTrajectoryEvents({
      events: [],
      cursors: {},
      queuePath: path.join(os.tmpdir(), "unused.jsonl"),
      source: "antigravity",
    });
    assert.equal(result.eventsAggregated, 0);
    assert.equal(result.bucketsQueued, 0);
  });

  it("skips events with zero tokens", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-traj-zero-"));
    try {
      const queuePath = path.join(tmp, "queue.jsonl");
      const events = [
        { timestamp: "2026-07-22T10:00:00Z", model: "claude-sonnet-4", inputTokens: 0, outputTokens: 0 },
        { timestamp: "2026-07-22T10:00:00Z", model: "claude-sonnet-4", inputTokens: 100, outputTokens: 50 },
      ];
      const result = await parseAntigravityTrajectoryEvents({
        events,
        cursors: {},
        queuePath,
        source: "antigravity",
      });
      assert.equal(result.eventsAggregated, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
