/**
 * Qoder / QoderWork parser test.
 *
 * Builds synthetic SQLite fixtures and verifies:
 *   - model_level maps to qoder-* models correctly.
 *   - path resolution functions correctly.
 *   - incremental parsing of agents.db (QoderWork) and local.db (Qoder IDE).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { sqliteOnlyCp: cp } = require("./helpers/sqlite-write");

const {
  resolveQoderPaths,
  normalizeQoderModel,
  parseQoderIncremental,
} = require("../src/lib/rollout");

function makeQoderWorkDb(dbPath, messages, subChats) {
  // Create tables messages and sub_chats
  const schema = `
    CREATE TABLE sub_chats (
      id TEXT PRIMARY KEY,
      model_level TEXT,
      created_at INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      sub_chat_id TEXT,
      created_at INTEGER
    );
  `;
  cp.execFileSync("sqlite3", [dbPath, schema]);

  for (const sc of subChats) {
    cp.execFileSync("sqlite3", [dbPath, `INSERT INTO sub_chats (id, model_level, created_at) VALUES ('${sc.id}', '${sc.model_level}', ${sc.created_at});`]);
  }

  for (const msg of messages) {
    const meta = JSON.stringify(msg.metadata).replace(/'/g, "''");
    cp.execFileSync("sqlite3", [dbPath, `INSERT INTO messages (id, role, metadata, sub_chat_id, created_at) VALUES ('${msg.id}', '${msg.role}', '${meta}', '${msg.sub_chat_id}', ${msg.created_at});`]);
  }
}

function makeQoderIdeDb(dbPath, chatMessages, columns = ["id", "token_info", "gmt_create", "model"]) {
  const colDefs = columns.map(c => {
    if (c === "id") return "id TEXT PRIMARY KEY";
    if (c === "token_info") return "token_info TEXT";
    return `${c} TEXT`;
  }).join(", ");

  const schema = `CREATE TABLE chat_message (${colDefs});`;
  cp.execFileSync("sqlite3", [dbPath, schema]);

  for (const cm of chatMessages) {
    const cols = Object.keys(cm).join(", ");
    const vals = Object.keys(cm).map(k => {
      const val = cm[k];
      if (typeof val === "object") {
        return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
      }
      return typeof val === "number" ? val : `'${val}'`;
    }).join(", ");

    cp.execFileSync("sqlite3", [dbPath, `INSERT INTO chat_message (${cols}) VALUES (${vals});`]);
  }
}

test("normalizeQoderModel maps model levels correctly", () => {
  assert.equal(normalizeQoderModel("kmodel"), "qoder-kmodel");
  assert.equal(normalizeQoderModel("qmodel"), "qoder-qmodel");
  assert.equal(normalizeQoderModel("qmodel_latest"), "qoder-qmodel-latest");
  assert.equal(normalizeQoderModel("qmodel_preview"), "qoder-qmodel-preview");
  assert.equal(normalizeQoderModel("gm51model"), "qoder-gm51model");
  assert.equal(normalizeQoderModel(""), "qoder-agent");
  assert.equal(normalizeQoderModel(null), "qoder-agent");
  assert.equal(normalizeQoderModel("custom-model"), "custom-model");
});

test("resolveQoderPaths resolves paths using env variables", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-paths-"));
  const env = { APPDATA: tempDir };

  // Create mock QoderWork Agents DB
  const workDir = path.join(tempDir, "QoderWork CN", "data");
  fs.mkdirSync(workDir, { recursive: true });
  const workDb = path.join(workDir, "agents.db");
  fs.writeFileSync(workDb, "dummy sqlite");

  // Create mock Qoder IDE local DB
  const ideDir = path.join(tempDir, "Qoder", "SharedClientCache", "cache", "db");
  fs.mkdirSync(ideDir, { recursive: true });
  const ideDb = path.join(ideDir, "local.db");
  fs.writeFileSync(ideDb, "dummy sqlite");

  const resolved = resolveQoderPaths(env);
  assert.equal(resolved.workDbPath, workDb);
  assert.equal(resolved.ideDbPath, ideDb);

  // Clean up
  try {
    fs.rmSync(tempDir, { recursive: true });
  } catch (_e) {}
});

test("parseQoderIncremental: QoderWork agents.db parsing and cursor update", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-work-parse-"));
  const workDir = path.join(tempDir, "QoderWork CN", "data");
  fs.mkdirSync(workDir, { recursive: true });
  const workDbPath = path.join(workDir, "agents.db");
  const queuePath = path.join(tempDir, "queue.jsonl");

  const subChats = [
    { id: "sc-1", model_level: "qmodel_latest", created_at: 1781058000 },
    { id: "sc-2", model_level: "kmodel", created_at: 1781058300 },
  ];

  const messages = [
    {
      id: "m-1",
      role: "assistant",
      metadata: {
        inputTokens: 120,
        outputTokens: 80,
        cacheReadTokens: 10,
        cacheWriteTokens: 20,
      },
      sub_chat_id: "sc-1",
      created_at: 1781058010,
    },
    {
      id: "m-2",
      role: "assistant",
      metadata: {
        inputTokens: 50,
        outputTokens: 30,
      },
      sub_chat_id: "sc-2",
      created_at: 1781058310,
    },
  ];

  makeQoderWorkDb(workDbPath, messages, subChats);

  // Set up mock path resolution env
  const mockEnv = { APPDATA: tempDir };
  const cursors = { hourly: {} };
  
  // Call parser with overridden paths or mock env
  const result = await parseQoderIncremental({
    cursors,
    queuePath,
    env: mockEnv,
    sqliteOptions: {
      execFileSync(bin, args) {
        if (args[2] && args[2].includes("sqlite_master")) {
          return "[]";
        }
        const db = new (require("node:sqlite").DatabaseSync)(workDbPath, { readOnly: true });
        try {
          const rows = db.prepare(args[3]).all();
          return JSON.stringify(rows);
        } finally {
          db.close();
        }
      }
    }
  });

  assert.equal(result.eventsAggregated, 2);
  assert.equal(cursors.qoder.lastWorkCreatedAt, 1781058310);
  assert.deepEqual(cursors.qoder.lastWorkIds, ["m-2"]);

  // Clean up
  try {
    fs.rmSync(tempDir, { recursive: true });
  } catch (_e) {}
});

test("parseQoderIncremental: Qoder IDE local.db parsing and cursor update", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-ide-parse-"));
  const ideDir = path.join(tempDir, "Qoder", "SharedClientCache", "cache", "db");
  fs.mkdirSync(ideDir, { recursive: true });
  const ideDbPath = path.join(ideDir, "local.db");
  const queuePath = path.join(tempDir, "queue.jsonl");

  const chatMessages = [
    {
      id: "msg-1",
      token_info: {
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 15,
        cacheWriteTokens: 25,
      },
      gmt_create: 1781059000,
      model: "gm51model",
    },
    {
      id: "msg-2",
      token_info: {
        inputTokens: 150,
        outputTokens: 75,
      },
      gmt_create: 1781059500,
      model: "qmodel",
    }
  ];

  makeQoderIdeDb(ideDbPath, chatMessages);

  const cursors = { hourly: {} };

  const result = await parseQoderIncremental({
    cursors,
    queuePath,
    env: { APPDATA: tempDir },
    sqliteOptions: {
      execFileSync(bin, args) {
        const db = new (require("node:sqlite").DatabaseSync)(ideDbPath, { readOnly: true });
        try {
          const rows = db.prepare(args[3]).all();
          return JSON.stringify(rows);
        } finally {
          db.close();
        }
      }
    }
  });

  assert.equal(result.eventsAggregated, 2);
  assert.equal(cursors.qoder.lastIdeCreatedAt, 1781059500);
  assert.deepEqual(cursors.qoder.lastIdeIds, ["msg-2"]);

  // Clean up
  try {
    fs.rmSync(tempDir, { recursive: true });
  } catch (_e) {}
});
