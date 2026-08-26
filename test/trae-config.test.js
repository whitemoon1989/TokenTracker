const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { test } = require("node:test");

const {
  resolveTraeCnPaths,
  resolveTraeCnPathsList,
  resolveTraeCnDbKey,
  verifyTraeDbKey,
  decryptTraeDb,
} = require("../src/lib/trae-config");

test("resolveTraeCnPaths and resolveTraeCnPathsList return expected path shapes for platform", () => {
  const paths = resolveTraeCnPaths({ home: "/my/home", platform: "darwin" });
  assert.equal(paths.appDir, "/my/home/Library/Application Support/Trae CN");
  assert.equal(paths.dbPath, "/my/home/Library/Application Support/Trae CN/ModularData/ai-agent/database.db");

  const winPaths = resolveTraeCnPaths({ home: "C:\\Users\\test", platform: "win32", env: { APPDATA: "C:\\AppData" } });
  assert.equal(winPaths.appDir, "C:\\AppData\\Trae CN");
  assert.equal(winPaths.dbPath, "C:\\AppData\\Trae CN\\ModularData\\ai-agent\\database.db");

  const list = resolveTraeCnPathsList({ home: "C:\\Users\\test", platform: "win32", env: { APPDATA: "C:\\AppData" } });
  assert.equal(list.length, 8);
  const traeWorkCn = list.find((c) => c.dirName === "Trae Work CN");
  assert.ok(traeWorkCn);
  assert.equal(traeWorkCn.appDir, "C:\\AppData\\Trae Work CN");
  assert.equal(traeWorkCn.dbPath, "C:\\AppData\\Trae Work CN\\ModularData\\ai-agent\\database.db");

  const traeSoloCn = list.find((c) => c.dirName === "TRAE SOLO CN");
  assert.ok(traeSoloCn);
  assert.equal(traeSoloCn.appDir, "C:\\AppData\\TRAE SOLO CN");
});

test("SQLCipher 4 pure JS decryption and HMAC validation verification", () => {
  // 1. Prepare key and salt
  const mockKeyHex = "3605f6691095a993f03d5009c918352ef5be31ae31e8f000212b81ff058da773";
  const mockKey = Buffer.from(mockKeyHex, "hex");
  const salt = crypto.randomBytes(16);

  // 2. Derive MAC key
  const macSalt = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    macSalt[i] = salt[i] ^ 0x3a;
  }
  const macKey = crypto.pbkdf2Sync(mockKey, macSalt, 2, 32, "sha512");

  // 3. Prepare plaintext for page 1
  const SQLITE_HDR = Buffer.from("SQLite format 3\x00", "binary");
  const pageBodyPlaintext = crypto.randomBytes(4000); // Total 4016 bytes with header

  // 4. Encrypt page 1
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", mockKey, iv);
  cipher.setAutoPadding(false);
  const encryptedBody = Buffer.concat([cipher.update(pageBodyPlaintext), cipher.final()]);

  // 5. Compute HMAC
  // hmacData is from index 16 to 4032, which is encryptedBody (4000 bytes) + iv (16 bytes)
  const hmacData = Buffer.concat([encryptedBody, iv]);
  const pgnoBuf = Buffer.alloc(4);
  pgnoBuf.writeUInt32LE(1, 0);

  const hmac = crypto.createHmac("sha512", macKey);
  hmac.update(hmacData);
  hmac.update(pgnoBuf);
  const computedHmac = hmac.digest();

  // 6. Assemble Page 1
  // Layout: salt(16) + encryptedBody(4000) + iv(16) + computedHmac(64) = 4096 bytes
  const page1 = Buffer.concat([salt, encryptedBody, iv, computedHmac]);
  assert.equal(page1.length, 4096);

  // 7. Write mock encrypted database to a temp file
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-trae-test-"));
  const dbPath = path.join(tempDir, "database.db");
  const decryptedPath = path.join(tempDir, "database_decrypted.db");
  fs.writeFileSync(dbPath, page1);

  // 8. Run verifyTraeDbKey tests
  assert.equal(verifyTraeDbKey(dbPath, mockKeyHex), true, "HMAC validation should succeed with correct key");
  assert.equal(verifyTraeDbKey(dbPath, "0".repeat(64)), false, "HMAC validation should fail with incorrect key");

  // 9. Run decryptTraeDb test
  decryptTraeDb(dbPath, decryptedPath, mockKeyHex);

  // 10. Verify decrypted page 1 output
  const decryptedBytes = fs.readFileSync(decryptedPath);
  assert.equal(decryptedBytes.length, 4096);

  const outHeader = decryptedBytes.subarray(0, 16);
  assert.deepEqual(outHeader, SQLITE_HDR, "Decrypted page 1 header should match SQLite format 3");

  const outBody = decryptedBytes.subarray(16, 4016);
  assert.deepEqual(outBody, pageBodyPlaintext, "Decrypted body should match original plaintext body");

  const outReserve = decryptedBytes.subarray(4016);
  assert.deepEqual(outReserve, Buffer.alloc(80), "Trailing reserve area should be zeroed");

  // Cleanup
  fs.unlinkSync(dbPath);
  fs.unlinkSync(decryptedPath);
  fs.rmdirSync(tempDir);
});
