const path = require("node:path");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const https = require("node:https");
const { readJson, writeJson, ensureDir, openLock } = require("./fs");
const { 
  getTraeCacheDir, 
  getTraeTokenAndHost,
  resolveTraeCnPaths,
  resolveTraeCnPathsList,
  resolveTraeCnDbKey,
  verifyTraeDbKey,
  decryptTraeDb
} = require("./trae-config");
const { readSqliteJsonRows } = require("./sqlite-reader");

const PAGE_SIZE = 20;
const API_PAGE_DELAY_MS = 300;
const OVERLAP_MARGIN_SECS = 7200; // 2-hour overlap buffer
const MANIFEST_VERSION = 1;

async function loadManifest(cacheDir) {
  const filePath = path.join(cacheDir, "manifest.json");
  const manifest = await readJson(filePath);
  if (!manifest) {
    return {
      version: MANIFEST_VERSION,
      last_synced_at: 0,
      last_turn_id: 0,
      sessions: [],
    };
  }
  if (manifest.last_turn_id === undefined) {
    manifest.last_turn_id = 0;
  }
  return manifest;
}

async function saveManifest(cacheDir, manifest) {
  const filePath = path.join(cacheDir, "manifest.json");
  await writeJson(filePath, manifest);
}

function shouldReplaceSessionEntry(existing, incoming) {
  return incoming.usage_time > existing.usage_time
    || (incoming.usage_time === existing.usage_time
        && incoming.artifact_path > existing.artifact_path);
}

function mergeManifestSessions(existing, incoming) {
  const map = new Map();
  for (const entry of existing) {
    map.set(entry.session_id, entry);
  }
  for (const entry of incoming) {
    if (map.has(entry.session_id)) {
      const exist = map.get(entry.session_id);
      if (shouldReplaceSessionEntry(exist, entry)) {
        map.set(entry.session_id, entry);
      }
    } else {
      map.set(entry.session_id, entry);
    }
  }
  const merged = Array.from(map.values());
  merged.sort((a, b) => a.session_id.localeCompare(b.session_id));
  return merged;
}

function manifestReferencesArtifact(sessions, artifactPath) {
  return sessions.some((entry) => entry.artifact_path === artifactPath);
}

async function fetchUsagePages(host, token, startTime, endTime, usageTypes) {
  let all = [];
  let page = 1;

  const fetchPage = (pageNum) => {
    return new Promise((resolve, reject) => {
      const url = new URL(`${host}/trae/api/v1/pay/query_user_usage_group_by_session`);
      const postData = JSON.stringify({
        start_time: startTime,
        end_time: endTime,
        page_size: PAGE_SIZE,
        page_num: pageNum,
        usage_type: usageTypes,
      });

      const options = {
        method: "POST",
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        headers: {
          "Content-Type": "application/json",
          "authorization": `Cloud-IDE-JWT ${token}`,
          "Content-Length": Buffer.byteLength(postData),
        },
        timeout: 30000,
      };

      const req = https.request(options, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Usage API returned ${res.statusCode}: ${body}`));
            return;
          }
          try {
            const data = JSON.parse(body);
            resolve(data);
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on("error", (e) => reject(e));
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Usage API timeout"));
      });
      req.write(postData);
      req.end();
    });
  };

  while (true) {
    const data = await fetchPage(page);
    const sessions = data.user_usage_group_by_sessions || [];
    const batch = sessions.length;
    all.push(...sessions);

    if (batch === 0 || (data.total !== undefined && data.total !== null && all.length >= data.total)) {
      break;
    }
    page += 1;
    await new Promise((resolve) => setTimeout(resolve, API_PAGE_DELAY_MS));
  }

  return all;
}

async function syncTraeUsage(variant, sinceDays, includeAux) {
  const cacheDir = await getTraeCacheDir();
  await ensureDir(cacheDir);

  const lockPath = path.join(cacheDir, "sync.lock");
  const lock = await openLock(lockPath, { quietIfLocked: true });
  if (!lock) {
    throw new Error(`Another trae sync is in progress; aborting`);
  }

  try {
    const { token, host } = await getTraeTokenAndHost(variant);
    const now = Math.floor(Date.now() / 1000);
    const manifest = await loadManifest(cacheDir);

    const sinceUser = now - sinceDays * 86400;
    const sinceManifest = manifest.last_synced_at > 0 ? manifest.last_synced_at - OVERLAP_MARGIN_SECS : 0;
    const startTime = sinceManifest > 0 ? Math.min(sinceUser, sinceManifest) : sinceUser;
    const endTime = now;

    const usageTypes = includeAux ? [1, 2, 3, 4, 5, 6, 7, 8] : [5, 6];

    const sessions = await fetchUsagePages(host, token, startTime, endTime, usageTypes);
    if (sessions.length === 0) {
      return 0;
    }

    const sessionsDir = path.join(cacheDir, "sessions");
    await ensureDir(sessionsDir);

    const nextManifest = {
      version: MANIFEST_VERSION,
      last_synced_at: now,
      last_turn_id: manifest.last_turn_id || 0,
      sessions: [...manifest.sessions],
    };

    const nowD = new Date();
    const pad = (n, l = 2) => String(n).padStart(l, "0");
    const batchTs = `${nowD.getUTCFullYear()}${pad(nowD.getUTCMonth()+1)}${pad(nowD.getUTCDate())}T${pad(nowD.getUTCHours())}${pad(nowD.getUTCMinutes())}${pad(nowD.getUTCSeconds())}${pad(nowD.getUTCMilliseconds(), 3)}`;
    const artifactFilename = `usage-${batchTs}.json`;
    const manifestSessionPath = `sessions/${artifactFilename}`;
    const artifactPath = path.join(sessionsDir, artifactFilename);

    const incomingSessions = [];
    for (const s of sessions) {
      const sessionId = s.session_id;
      if (!sessionId) continue;
      const usageTime = s.usage_time || 0;
      incomingSessions.push({
        session_id: sessionId,
        usage_time: usageTime,
        artifact_path: manifestSessionPath,
      });
    }

    nextManifest.sessions = mergeManifestSessions(nextManifest.sessions, incomingSessions);

    const batchWinsManifest = manifestReferencesArtifact(nextManifest.sessions, manifestSessionPath);

    if (batchWinsManifest) {
      await writeJson(artifactPath, sessions);
    }

    // GC unused artifact files
    const validPaths = new Set(nextManifest.sessions.map((e) => e.artifact_path));
    try {
      const files = await fs.readdir(sessionsDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const rel = `sessions/${file}`;
        if (!validPaths.has(rel)) {
          await fs.unlink(path.join(sessionsDir, file)).catch(() => {});
        }
      }
    } catch (_e) {}

    await saveManifest(cacheDir, nextManifest);
    return sessions.length;
  } finally {
    await lock.release().catch(() => {});
  }
}

async function syncTraeCnLocal() {
  const cacheDir = await getTraeCacheDir();
  await ensureDir(cacheDir);

  const lockPath = path.join(cacheDir, "sync-cn.lock");
  const lock = await openLock(lockPath, { quietIfLocked: true });
  if (!lock) {
    throw new Error(`Another trae cn sync is in progress; aborting`);
  }

  const decryptedTempPath = path.join(cacheDir, "database_decrypted.db");

  try {
    const candidateList = resolveTraeCnPathsList();
    const seenPaths = new Set();
    const existingCandidates = [];
    for (const c of candidateList) {
      if (!fssync.existsSync(c.dbPath)) continue;
      let real = c.dbPath;
      try {
        real = fssync.realpathSync(c.dbPath);
      } catch (_e) {}
      const key = process.platform === "win32" ? real.toLowerCase() : real;
      if (!seenPaths.has(key)) {
        seenPaths.add(key);
        existingCandidates.push(c);
      }
    }
    if (existingCandidates.length === 0) {
      return 0; // No Trae CN databases found
    }

    const encKey = await resolveTraeCnDbKey();
    if (!encKey) {
      process.stderr.write("  [tokentracker] 检测到 Trae CN 本地数据库存在，但未找到解密密钥。请运行 trae-db-decrypt 提取密钥以获取用量。\n");
      return 0;
    }

    const manifest = await loadManifest(cacheDir);
    const lastTurnIds = { ...(manifest.last_turn_ids || {}) };
    if (lastTurnIds["Trae CN"] === undefined && manifest.last_turn_id) {
      lastTurnIds["Trae CN"] = manifest.last_turn_id;
    }

    const totalConvertedSessions = [];
    const now = Math.floor(Date.now() / 1000);

    for (const c of existingCandidates) {
      if (!verifyTraeDbKey(c.dbPath, encKey)) {
        process.stderr.write(`  [tokentracker] Trae CN (${c.dirName}) 本地数据库 HMAC 校验失败，可能是密钥已失效或配置不正确。\n`);
        continue;
      }

      // Decrypt database to temporary path
      try {
        decryptTraeDb(c.dbPath, decryptedTempPath, encKey);
      } catch (err) {
        process.stderr.write(`  [tokentracker] 解密 Trae CN (${c.dirName}) 本地数据库失败: ${err.message}\n`);
        continue;
      }

      const lastTurnId = lastTurnIds[c.dirName] || 0;

      // Load turns
      let turns = [];
      try {
        turns = readSqliteJsonRows(
          decryptedTempPath,
          `SELECT id, session_id, context, created_at FROM chat_turn WHERE id > ${lastTurnId} AND context IS NOT NULL`
        );
      } catch (_err) {
        try {
          turns = readSqliteJsonRows(
            decryptedTempPath,
            `SELECT t.id, t.session_id, t.context, s.created_at FROM chat_turn t LEFT JOIN chat_session s ON t.session_id = s.id WHERE t.id > ${lastTurnId} AND t.context IS NOT NULL`
          );
        } catch (_e) {
          turns = readSqliteJsonRows(
            decryptedTempPath,
            `SELECT id, session_id, context FROM chat_turn WHERE id > ${lastTurnId} AND context IS NOT NULL`
          );
        }
      }

      // Clean up temp DB immediately after query
      try {
        if (fssync.existsSync(decryptedTempPath)) {
          fssync.unlinkSync(decryptedTempPath);
        }
      } catch (_e) {}

      if (turns.length === 0) {
        lastTurnIds[c.dirName] = lastTurnId;
        continue;
      }

      // Map turns to sessions format
      const sessionsMap = new Map();
      let maxTurnId = lastTurnId;

      for (const t of turns) {
        if (t.id > maxTurnId) {
          maxTurnId = t.id;
        }
        const sessionId = t.session_id;
        if (!sessionId) continue;

        let ctx;
        try {
          ctx = JSON.parse(t.context);
        } catch (_e) {
          continue;
        }

        const tu = ctx.token_usage || {};
        if (!tu || (!tu.total_tokens && !tu.prompt_tokens)) continue;

        let modelName = "unknown";
        if (ctx.persist_user_message_context && ctx.persist_user_message_context.model_info) {
          modelName = ctx.persist_user_message_context.model_info.config_name || "unknown";
        }

        let createdAtVal = t.created_at;
        let createdAtMs = Date.now();
        if (createdAtVal !== undefined && createdAtVal !== null) {
          const valNum = Number(createdAtVal);
          if (!isNaN(valNum)) {
            createdAtMs = valNum > 10000000000 ? valNum : valNum * 1000;
          } else {
            const parsed = Date.parse(createdAtVal);
            if (!isNaN(parsed)) {
              createdAtMs = parsed;
            }
          }
        }

        const useTime = Math.floor(createdAtMs / 1000);

        const detail = {
          prompt_tokens: tu.prompt_tokens || 0,
          completion_tokens: tu.completion_tokens || 0,
          total_tokens: tu.total_tokens || 0,
          cache_read_input_tokens: tu.cache_read_input_tokens || 0,
          cache_creation_input_tokens: tu.cache_creation_input_tokens || 0,
          use_time: useTime,
        };

        if (!sessionsMap.has(sessionId)) {
          sessionsMap.set(sessionId, new Map());
        }
        const modelMap = sessionsMap.get(sessionId);
        if (!modelMap.has(modelName)) {
          modelMap.set(modelName, []);
        }
        modelMap.get(modelName).push(detail);
      }

      for (const [sessionId, modelMap] of sessionsMap.entries()) {
        const modelsArr = [];
        let maxUseTime = 0;
        let totalPrompt = 0, totalCompletion = 0, totalCacheRead = 0, totalCacheCreation = 0;
        let bestModel = "unknown";
        let maxModelTokens = -1;

        for (const [modelName, details] of modelMap.entries()) {
          let sumPrompt = 0, sumCompletion = 0, sumTotal = 0, sumCacheRead = 0, sumCacheCreation = 0;
          for (const d of details) {
            sumPrompt += d.prompt_tokens;
            sumCompletion += d.completion_tokens;
            sumTotal += d.total_tokens;
            sumCacheRead += d.cache_read_input_tokens;
            sumCacheCreation += d.cache_creation_input_tokens;
            if (d.use_time > maxUseTime) {
              maxUseTime = d.use_time;
            }
          }

          totalPrompt += sumPrompt;
          totalCompletion += sumCompletion;
          totalCacheRead += sumCacheRead;
          totalCacheCreation += sumCacheCreation;

          if (sumTotal > maxModelTokens) {
            maxModelTokens = sumTotal;
            bestModel = modelName;
          }

          modelsArr.push({
            model_name: modelName,
            prompt_tokens: sumPrompt,
            completion_tokens: sumCompletion,
            total_tokens: sumTotal,
            cache_read_input_tokens: sumCacheRead,
            cache_creation_input_tokens: sumCacheCreation,
            detail: details,
          });
        }

        totalConvertedSessions.push({
          session_id: sessionId,
          usage_time: maxUseTime || now,
          model_name: bestModel,
          extra_info: {
            input_token: totalPrompt,
            output_token: totalCompletion,
            cache_read_token: totalCacheRead,
            cache_write_token: totalCacheCreation,
          },
          user_usage_group_by_models: modelsArr,
        });
      }

      lastTurnIds[c.dirName] = maxTurnId;
    }

    if (totalConvertedSessions.length === 0) {
      return 0;
    }

    const sessionsDir = path.join(cacheDir, "sessions");
    await ensureDir(sessionsDir);

    const nowD = new Date();
    const pad = (n, l = 2) => String(n).padStart(l, "0");
    const batchTs = `${nowD.getUTCFullYear()}${pad(nowD.getUTCMonth()+1)}${pad(nowD.getUTCDate())}T${pad(nowD.getUTCHours())}${pad(nowD.getUTCMinutes())}${pad(nowD.getUTCSeconds())}${pad(nowD.getUTCMilliseconds(), 3)}`;
    const artifactFilename = `usage-cn-local-${batchTs}.json`;
    const manifestSessionPath = `sessions/${artifactFilename}`;
    const artifactPath = path.join(sessionsDir, artifactFilename);

    const incomingSessions = [];
    for (const s of totalConvertedSessions) {
      incomingSessions.push({
        session_id: s.session_id,
        usage_time: s.usage_time,
        artifact_path: manifestSessionPath,
      });
    }

    const maxTurnIdAll = Math.max(0, ...Object.values(lastTurnIds));

    const nextManifest = {
      version: MANIFEST_VERSION,
      last_synced_at: now,
      last_turn_id: maxTurnIdAll,
      last_turn_ids: lastTurnIds,
      sessions: mergeManifestSessions(manifest.sessions, incomingSessions),
    };

    const batchWinsManifest = manifestReferencesArtifact(nextManifest.sessions, manifestSessionPath);
    if (batchWinsManifest) {
      await writeJson(artifactPath, totalConvertedSessions);
    }

    // GC
    const validPaths = new Set(nextManifest.sessions.map((e) => e.artifact_path));
    try {
      const files = await fs.readdir(sessionsDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const rel = `sessions/${file}`;
        if (!validPaths.has(rel)) {
          await fs.unlink(path.join(sessionsDir, file)).catch(() => {});
        }
      }
    } catch (_e) {}

    await saveManifest(cacheDir, nextManifest);
    return totalConvertedSessions.length;
  } finally {
    // Secure delete temporary decrypted database
    try {
      if (fssync.existsSync(decryptedTempPath)) {
        fssync.unlinkSync(decryptedTempPath);
      }
    } catch (_e) {}
    await lock.release().catch(() => {});
  }
}

module.exports = {
  syncTraeUsage,
  syncTraeCnLocal,
};
