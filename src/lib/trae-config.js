const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const crypto = require("node:crypto");
const https = require("node:https");
const { readJson, writeJson, ensureDir } = require("./fs");
const { resolveTrackerPaths } = require("./tracker-paths");

const INTL_HOST = "https://api-sg-central.trae.ai";
const INTL_CLIENT_ID = "en1oxy7wnw8j9n";
const EXCHANGE_TOKEN_PATH = "/cloudide/api/v3/trae/oauth/ExchangeToken";

const JG = [
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130,
  155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61,
  238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73,
  109, 139, 209, 37,
];
const KG = [
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25,
  181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176,
  200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99,
  85, 33, 12, 125,
];

function hardcodedPassword() {
  const pw = Buffer.alloc(64);
  for (let i = 0; i < 64; i++) {
    pw[i] = JG[i] ^ KG[i];
  }
  return pw;
}

function decryptBlob(blob) {
  const MAGIC = Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]);
  if (blob.length < MAGIC.length + 32 + 16) {
    throw new Error("Blob too short");
  }
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("Magic header mismatch");
  }
  const salt = blob.subarray(MAGIC.length, MAGIC.length + 32);
  const ciphertext = blob.subarray(MAGIC.length + 32);
  if (ciphertext.length % 16 !== 0) {
    throw new Error("Ciphertext length not a multiple of 16");
  }

  // Derive key and IV
  const shaSalt = crypto.createHash("sha512").update(salt).digest();
  const kdfBuf = Buffer.concat([shaSalt, hardcodedPassword()], 128);
  const kdfOut = crypto.createHash("sha512").update(kdfBuf).digest();

  const key = kdfOut.subarray(0, 16);
  const iv = kdfOut.subarray(16, 32);

  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(true);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  if (decrypted.length < 64) {
    throw new Error("Decrypted plaintext too short");
  }

  const expectedHash = decrypted.subarray(0, 64);
  const data = decrypted.subarray(64);

  const actualHash = crypto.createHash("sha512").update(data).digest();
  if (!expectedHash.equals(actualHash)) {
    throw new Error("SHA-512 integrity check failed");
  }

  return data;
}

function decryptBase64Blob(b64) {
  const blob = Buffer.from(b64.trim(), "base64");
  const ptBytes = decryptBlob(blob);
  return ptBytes.toString("utf8");
}

function getTraeAppDirName(variant) {
  return variant === "solo" ? "TRAE SOLO" : "Trae";
}

function resolveTraePaths({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const pathForPlatform = platform === "win32" ? path.win32 : path.posix;
  
  const getPaths = (variant) => {
    let appDir;
    const dirName = getTraeAppDirName(variant);
    if (platform === "darwin") {
      appDir = pathForPlatform.join(home, "Library", "Application Support", dirName);
    } else if (platform === "win32") {
      const appData = (typeof env.APPDATA === "string" && env.APPDATA.trim()) || pathForPlatform.join(home, "AppData", "Roaming");
      appDir = pathForPlatform.join(appData, dirName);
    } else {
      const xdg = (typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()) || pathForPlatform.join(home, ".config");
      appDir = pathForPlatform.join(xdg, dirName);
    }
    return {
      appDir,
      storageJson: pathForPlatform.join(appDir, "User", "globalStorage", "storage.json"),
    };
  };

  return {
    ide: getPaths("ide"),
    solo: getPaths("solo"),
  };
}

function isTraeInstalled({ home, platform, env } = {}) {
  const paths = resolveTraePaths({ home, platform, env });
  const hasIde = fssync.existsSync(paths.ide.appDir);
  const hasSolo = fssync.existsSync(paths.solo.appDir);
  return { ide: hasIde, solo: hasSolo };
}

async function getTraeCacheDir() {
  const { rootDir } = await resolveTrackerPaths();
  return path.join(rootDir, "trae-cache");
}

function getCredentialsFilename(variant) {
  return variant === "solo" ? "credentials-solo.json" : "credentials-ide.json";
}

async function getCredentialsPath(variant) {
  const cacheDir = await getTraeCacheDir();
  return path.join(cacheDir, getCredentialsFilename(variant));
}

async function loadCredentials(variant) {
  const filePath = await getCredentialsPath(variant);
  return await readJson(filePath);
}

async function saveCredentials(creds) {
  const cacheDir = await getTraeCacheDir();
  await ensureDir(cacheDir);
  const filePath = await getCredentialsPath(creds.variant);
  await writeJson(filePath, creds);
}

async function clearCredentials(variant) {
  const filePath = await getCredentialsPath(variant);
  try {
    await fs.unlink(filePath);
  } catch (_e) {}
}

function isTokenExpired(creds) {
  if (!creds.expired_at) return true;
  const exp = Date.parse(creds.expired_at);
  if (isNaN(exp)) return true;
  // 5 minutes safety margin
  return Date.now() > exp - 300000;
}

function isRefreshExpired(creds) {
  if (!creds.refresh_expired_at) return true;
  const exp = Date.parse(creds.refresh_expired_at);
  if (isNaN(exp)) return true;
  // 1 day safety margin
  return Date.now() > exp - 86400000;
}

function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const raw = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(json);
  } catch (_e) {
    return null;
  }
}

function epochMsToIso(ms) {
  try {
    return new Date(ms).toISOString();
  } catch (_e) {
    return "";
  }
}

function epochSecsToIso(secs) {
  return epochMsToIso(secs * 1000);
}

async function exchangeToken(host, clientId, refreshToken, currentToken) {
  return new Promise((resolve, reject) => {
    const urlStr = `${host}${EXCHANGE_TOKEN_PATH}`;
    const url = new URL(urlStr);
    const postData = JSON.stringify({
      ClientID: clientId,
      RefreshToken: refreshToken,
      ClientSecret: "-",
      UserID: "",
    });

    const options = {
      method: "POST",
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname,
      headers: {
        "Content-Type": "application/json",
        "x-cloudide-token": currentToken,
        "Content-Length": Buffer.byteLength(postData),
      },
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`ExchangeToken returned ${res.statusCode}: ${body}`));
          return;
        }
        try {
          const data = JSON.parse(body);
          const r = data.Result;
          if (!r || !r.Token) {
            reject(new Error("ExchangeToken returned empty token"));
            return;
          }
          resolve({
            token: r.Token,
            refresh_token: r.RefreshToken,
            expired_at: epochMsToIso(r.TokenExpireAt),
            refresh_expired_at: epochMsToIso(r.RefreshExpireAt),
          });
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", (e) => reject(e));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("ExchangeToken timeout"));
    });
    req.write(postData);
    req.end();
  });
}

async function decryptFromStorage(variant) {
  const paths = resolveTraePaths();
  const storagePath = paths[variant].storageJson;
  if (!fssync.existsSync(storagePath)) {
    throw new Error(`storage.json for ${variant} not found at ${storagePath}`);
  }

  const obj = await readJson(storagePath);
  if (!obj) {
    throw new Error(`Failed to read storage.json at ${storagePath}`);
  }

  let b64 = obj["iCubeAuthInfo://icube.cloudide"];
  if (!b64) {
    // Walk keys and find the longest starting with iCubeAuthInfo
    let longest = "";
    for (const key of Object.keys(obj)) {
      if (key.startsWith("iCubeAuthInfo") && typeof obj[key] === "string") {
        if (obj[key].length > longest.length) {
          longest = obj[key];
        }
      }
    }
    b64 = longest;
  }

  if (!b64) {
    throw new Error("No iCubeAuthInfo entry found in storage.json");
  }

  const decryptedJson = decryptBase64Blob(b64);
  const raw = JSON.parse(decryptedJson);

  const token = raw.token;
  const refreshToken = raw.refreshToken;
  if (!token || !refreshToken) {
    throw new Error("Missing token or refreshToken in iCubeAuthInfo");
  }

  const expired_at = raw.expiredAt || "";
  const refresh_expired_at = raw.refreshExpiredAt || "";
  const host = raw.host || INTL_HOST;
  const userId = raw.userId || null;

  return {
    variant,
    token,
    refresh_token: refreshToken,
    expired_at,
    refresh_expired_at,
    host,
    client_id: INTL_CLIENT_ID,
    source: "Auto",
    user_id: userId,
  };
}

async function resolveTraeToken(variant) {
  // 1. Cache hit & still valid
  let creds = await loadCredentials(variant);
  if (creds) {
    if (!isTokenExpired(creds)) {
      return creds.token;
    }
    // 2. Refresh token valid
    if (!isRefreshExpired(creds)) {
      try {
        const newTokens = await exchangeToken(creds.host, creds.client_id, creds.refresh_token, creds.token);
        creds.token = newTokens.token;
        creds.refresh_token = newTokens.refresh_token;
        creds.expired_at = newTokens.expired_at;
        creds.refresh_expired_at = newTokens.refresh_expired_at;
        await saveCredentials(creds);
        return creds.token;
      } catch (e) {
        process.stderr.write(`  Trae ${variant} refresh token failed: ${e.message}; falling back to storage.json decryption\n`);
      }
    }
  }

  // 3. Decrypt from storage.json
  try {
    creds = await decryptFromStorage(variant);
    if (isTokenExpired(creds)) {
      if (isRefreshExpired(creds)) {
        process.stderr.write(`  Trae ${variant} decrypted credentials are fully expired; falling through to manual login\n`);
      } else {
        try {
          const newTokens = await exchangeToken(creds.host, creds.client_id, creds.refresh_token, creds.token);
          creds.token = newTokens.token;
          creds.refresh_token = newTokens.refresh_token;
          creds.expired_at = newTokens.expired_at;
          creds.refresh_expired_at = newTokens.refresh_expired_at;
          await saveCredentials(creds);
          return creds.token;
        } catch (e) {
          process.stderr.write(`  Trae ${variant} decrypted token is stale and refresh failed: ${e.message}\n`);
        }
      }
    } else {
      await saveCredentials(creds);
      return creds.token;
    }
  } catch (e) {
    // Decrypt errors are common if not installed or database empty, just debug
    const dbg = String(process.env.TOKENTRACKER_DEBUG || "").toLowerCase();
    if (dbg === "1" || dbg === "true") {
      process.stderr.write(`  Trae ${variant} auto-decrypt failed: ${e.message}\n`);
    }
  }

  throw new Error(`Could not obtain a Trae ${variant} access token.`);
}

async function saveManualToken(variant, token, host) {
  const payload = decodeJwtPayload(token);
  let expired_at = "";
  let refresh_expired_at = "";
  
  if (payload) {
    if (payload.exp) expired_at = epochSecsToIso(payload.exp);
    else expired_at = new Date(Date.now() + 14 * 86400000).toISOString();

    if (payload.iat) refresh_expired_at = new Date((payload.iat + 180 * 86400) * 1000).toISOString();
    else refresh_expired_at = new Date(Date.now() + 180 * 86400000).toISOString();
  }

  const creds = {
    variant,
    token,
    refresh_token: "",
    expired_at,
    refresh_expired_at,
    host: host || INTL_HOST,
    client_id: INTL_CLIENT_ID,
    source: "Manual",
    user_id: null,
  };
  await saveCredentials(creds);
}

async function getTraeTokenAndHost(variant) {
  const token = await resolveTraeToken(variant);
  const creds = await loadCredentials(variant);
  const host = creds ? creds.host : INTL_HOST;
  return { token, host };
}

const TRAE_CN_DIR_NAMES = [
  "Trae CN",
  "TRAE SOLO CN",
  "Trae Solo CN",
  "Trae Work CN",
  "TRAE Work CN",
  "TRAE WORK CN",
  "Trae Work",
  "TRAE WORK",
];

function resolveTraeCnPathsList({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const pathForPlatform = platform === "win32" ? path.win32 : path.posix;
  let baseDir;
  if (platform === "darwin") {
    baseDir = pathForPlatform.join(home, "Library", "Application Support");
  } else if (platform === "win32") {
    baseDir = (typeof env.APPDATA === "string" && env.APPDATA.trim()) || pathForPlatform.join(home, "AppData", "Roaming");
  } else {
    baseDir = (typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()) || pathForPlatform.join(home, ".config");
  }

  return TRAE_CN_DIR_NAMES.map((dirName) => {
    const appDir = pathForPlatform.join(baseDir, dirName);
    return {
      dirName,
      appDir,
      dbPath: pathForPlatform.join(appDir, "ModularData", "ai-agent", "database.db"),
    };
  });
}

function resolveTraeCnPaths({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const list = resolveTraeCnPathsList({ home, platform, env });
  const primary = list[0];
  return {
    appDir: primary.appDir,
    dbPath: primary.dbPath,
    candidates: list,
  };
}

async function resolveTraeCnDbKey({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  // 1. Try config.json in tokentracker root
  try {
    const { rootDir } = await resolveTrackerPaths({ home });
    const configPath = path.join(rootDir, "config.json");
    if (fssync.existsSync(configPath)) {
      const config = JSON.parse(fssync.readFileSync(configPath, "utf8"));
      if (config && typeof config.trae_cn_db_key === "string" && config.trae_cn_db_key.trim()) {
        return config.trae_cn_db_key.trim();
      }
    }
  } catch (_e) {}

  // 2. Try AppData/trae-db-decrypt/decrypted_key.json
  try {
    let decryptToolKeyPath;
    if (platform === "win32") {
      const appData = (typeof env.APPDATA === "string" && env.APPDATA.trim()) || path.join(home, "AppData", "Roaming");
      decryptToolKeyPath = path.join(appData, "trae-db-decrypt", "decrypted_key.json");
    } else {
      decryptToolKeyPath = path.join(home, ".config", "trae-db-decrypt", "decrypted_key.json");
    }
    if (fssync.existsSync(decryptToolKeyPath)) {
      const data = JSON.parse(fssync.readFileSync(decryptToolKeyPath, "utf8"));
      if (data && typeof data.enc_key === "string" && data.enc_key.trim()) {
        return data.enc_key.trim();
      }
    }
  } catch (_e) {}

  // 3. Try current working directory decrypted_key.json
  try {
    const localKeyPath = path.join(process.cwd(), "decrypted_key.json");
    if (fssync.existsSync(localKeyPath)) {
      const data = JSON.parse(fssync.readFileSync(localKeyPath, "utf8"));
      if (data && typeof data.enc_key === "string" && data.enc_key.trim()) {
        return data.enc_key.trim();
      }
    }
  } catch (_e) {}

  return null;
}

function verifyTraeDbKey(encryptedPath, encKeyHex) {
  try {
    if (!encKeyHex || encKeyHex.length !== 64) return false;
    const encKey = Buffer.from(encKeyHex, "hex");
    const PAGE_SZ = 4096;
    const SALT_SZ = 16;
    const IV_SZ = 16;
    const RESERVE_SZ = 80;
    const HMAC_SZ = 64;

    const fd = fssync.openSync(encryptedPath, "r");
    const page1 = Buffer.alloc(PAGE_SZ);
    fssync.readSync(fd, page1, 0, PAGE_SZ, 0);
    fssync.closeSync(fd);

    const salt = page1.subarray(0, SALT_SZ);
    const macSalt = Buffer.alloc(salt.length);
    for (let i = 0; i < salt.length; i++) {
      macSalt[i] = salt[i] ^ 0x3a;
    }

    const macKey = crypto.pbkdf2Sync(encKey, macSalt, 2, 32, "sha512");
    const hmacData = page1.subarray(SALT_SZ, PAGE_SZ - RESERVE_SZ + IV_SZ);
    const storedHmac = page1.subarray(PAGE_SZ - HMAC_SZ, PAGE_SZ);

    const pgnoBuf = Buffer.alloc(4);
    pgnoBuf.writeUInt32LE(1, 0);

    const hmac = crypto.createHmac("sha512", macKey);
    hmac.update(hmacData);
    hmac.update(pgnoBuf);
    const computed = hmac.digest();

    return computed.equals(storedHmac);
  } catch (err) {
    return false;
  }
}

function decryptTraeDb(encryptedPath, decryptedPath, encKeyHex) {
  const encKey = Buffer.from(encKeyHex, "hex");
  const PAGE_SZ = 4096;
  const SALT_SZ = 16;
  const RESERVE_SZ = 80;
  const IV_SZ = 16;
  const SQLITE_HDR = Buffer.from("SQLite format 3\x00", "binary");

  const stats = fssync.statSync(encryptedPath);
  const fileSize = stats.size;
  const totalPages = Math.floor(fileSize / PAGE_SZ);

  const fdIn = fssync.openSync(encryptedPath, "r");
  const fdOut = fssync.openSync(decryptedPath, "w");

  const pageBuffer = Buffer.alloc(PAGE_SZ);

  for (let pgno = 1; pgno <= totalPages; pgno++) {
    fssync.readSync(fdIn, pageBuffer, 0, PAGE_SZ, (pgno - 1) * PAGE_SZ);
    const iv = pageBuffer.subarray(PAGE_SZ - RESERVE_SZ, PAGE_SZ - RESERVE_SZ + IV_SZ);

    let encryptedData;
    let decryptedBody;

    if (pgno === 1) {
      encryptedData = pageBuffer.subarray(SALT_SZ, PAGE_SZ - RESERVE_SZ);
      const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, iv);
      decipher.setAutoPadding(false);
      decryptedBody = Buffer.concat([decipher.update(encryptedData), decipher.final()]);

      const outPage = Buffer.alloc(PAGE_SZ);
      SQLITE_HDR.copy(outPage, 0);
      decryptedBody.copy(outPage, SQLITE_HDR.length);
      fssync.writeSync(fdOut, outPage, 0, PAGE_SZ);
    } else {
      encryptedData = pageBuffer.subarray(0, PAGE_SZ - RESERVE_SZ);
      const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, iv);
      decipher.setAutoPadding(false);
      decryptedBody = Buffer.concat([decipher.update(encryptedData), decipher.final()]);

      const outPage = Buffer.alloc(PAGE_SZ);
      decryptedBody.copy(outPage, 0);
      fssync.writeSync(fdOut, outPage, 0, PAGE_SZ);
    }
  }

  fssync.closeSync(fdIn);
  fssync.closeSync(fdOut);
}

module.exports = {
  INTL_HOST,
  INTL_CLIENT_ID,
  resolveTraePaths,
  isTraeInstalled,
  getTraeCacheDir,
  loadCredentials,
  saveCredentials,
  clearCredentials,
  resolveTraeToken,
  saveManualToken,
  getTraeTokenAndHost,
  resolveTraeCnPaths,
  resolveTraeCnPathsList,
  resolveTraeCnDbKey,
  verifyTraeDbKey,
  decryptTraeDb,
};
