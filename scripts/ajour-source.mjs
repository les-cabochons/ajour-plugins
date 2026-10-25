#!/usr/bin/env node
// Builds, signs and checks an Ajour plugin source: the ajour.json at the root
// of a git repository, which lists plugins as source files at a commit, and
// its optional signature, ajour.json.sig. Ajour plugin source format, version 1.
//
//   node scripts/ajour-source.mjs keygen [--out <file>]
//   node scripts/ajour-source.mjs release [--key <file>] [--unsigned]
//   node scripts/ajour-source.mjs verify [--public-key <base64>]
//   node scripts/ajour-source.mjs package <folder>
//
// This is one file with no dependencies beyond Node.js, so another plugin
// repository can copy it as it is. It finds plugins in plugins/<folder>/, and
// at the repository root when the root has a plugin.json. Each plugin's
// package.json has an "ajour" field with its listing; the root package.json
// names the source in "ajour.sourceName".
//
// The signing key passphrase comes from AJOUR_SIGNING_PASSPHRASE, or a hidden
// prompt.
import { spawnSync } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  sign,
  verify,
} from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

export const SOURCE_FILE = "ajour.json";
export const SIGNATURE_FILE = "ajour.json.sig";
export const PASSPHRASE_VARIABLE = "AJOUR_SIGNING_PASSPHRASE";
export const DEFAULT_KEY_FILE = join(homedir(), ".ajour", "signing-key.json");
export const SCRYPT_PARAMETERS = Object.freeze({ N: 131072, r: 8, p: 1 });

const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_SIGNATURE_BYTES = 4 * 1024;
const MAX_URL_LENGTH = 500;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_PLUGIN_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES = 1_000_000;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SPDX_PATTERN = /^[A-Za-z0-9.+-]{1,80}$/;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export const CATALOG_CAPABILITIES = Object.freeze([
  "connector",
  "codeHost",
  "calendar",
  "team",
  "agentTask",
  "schema",
]);
const STATUSES = ["available", "coming-soon", "deprecated"];
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "avif"];
const ENTRYPOINT_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"];

// plugin.json capability names, mapped to the names the source lists. A
// capability mapped to null only adds to another one and is not listed.
const PLUGIN_CAPABILITIES = {
  connector: "connector",
  codeHost: "codeHost",
  calendar: "calendar",
  team: "team",
  agentTask: "agentTask",
  schema: "schema",
  projectDataShape: "schema",
  projectProperties: null,
};

const LISTING_KEYS = [
  "name",
  "description",
  "features",
  "tags",
  "author",
  "license",
  "website",
  "status",
  "files",
  "images",
];

/** An expected failure: the CLI prints its message without a stack. */
export class SourceError extends Error {
  constructor(message) {
    super(message);
    this.name = "SourceError";
  }
}

// ---------------------------------------------------------------------------
// Validation of ajour.json, against the source format, version 1.

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function has(value, key) {
  return Object.hasOwn(value, key);
}

function checkKeys(value, label, required, optional, errors) {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object.`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      errors.push(`${label} has an unknown key "${key}".`);
    }
  }
  for (const key of required) {
    if (!has(value, key)) errors.push(`${label} is missing "${key}".`);
  }
  return true;
}

function checkText(value, label, min, max, errors) {
  if (typeof value !== "string") {
    errors.push(`${label} must be a string.`);
  } else if (value.length < min || value.length > max) {
    errors.push(`${label} must be ${min} to ${max} characters, not ${value.length}.`);
  }
}

function checkPattern(value, label, pattern, rule, errors) {
  if (typeof value !== "string" || !pattern.test(value)) {
    errors.push(`${label} ${rule}, not ${JSON.stringify(value)}.`);
  }
}

function checkHttpsUrl(value, label, errors) {
  let url;
  try {
    url = typeof value === "string" ? new URL(value) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== "https:" || url.hostname === "") {
    errors.push(`${label} must be an HTTPS URL, not ${JSON.stringify(value)}.`);
  } else if (value.length > MAX_URL_LENGTH) {
    errors.push(`${label} must be at most ${MAX_URL_LENGTH} characters.`);
  }
}

function checkList(value, label, min, max, checkItem, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array.`);
    return;
  }
  if (value.length < min || value.length > max) {
    errors.push(`${label} must have ${min} to ${max} entries, not ${value.length}.`);
  }
  const seen = new Set();
  value.forEach((item, index) => {
    checkItem(item, `${label}[${index}]`);
    if (seen.has(item)) errors.push(`${label} lists ${JSON.stringify(item)} twice.`);
    seen.add(item);
  });
}

function checkSlug(value, label, errors) {
  checkPattern(value, label, SLUG_PATTERN, "must be lowercase words joined by single hyphens", errors);
  if (typeof value === "string" && value.length > 80) {
    errors.push(`${label} must be at most 80 characters.`);
  }
}

/**
 * Why a relative path breaks the source format's path rules, or undefined
 * when it follows them: POSIX separators, 1 to 200 characters, and segments
 * of letters, digits, ".", "_" and "-" that are not "." or "..".
 */
export function relativePathProblem(value) {
  if (typeof value !== "string") return "must be a string";
  if (value.length < 1 || value.length > 200) return "must be 1 to 200 characters";
  for (const segment of value.split("/")) {
    if (segment === "") return 'must not start or end with "/" or have "//"';
    if (segment === "." || segment === "..") return `must not have a "${segment}" segment`;
    if (!SEGMENT_PATTERN.test(segment)) {
      return `has a segment ${JSON.stringify(segment)} with characters other than letters, digits, ".", "_" and "-"`;
    }
  }
  return undefined;
}

function checkFileEntry(value, label, errors) {
  if (!checkKeys(value, label, ["path", "sha256", "size"], [], errors)) return;
  const problem = relativePathProblem(value.path);
  if (problem) errors.push(`${label}.path ${problem}: ${JSON.stringify(value.path)}.`);
  checkPattern(value.sha256, `${label}.sha256`, SHA256_PATTERN, "must be 64 lowercase hex characters", errors);
  if (!Number.isInteger(value.size) || value.size < 0 || value.size > MAX_FILE_BYTES) {
    errors.push(`${label}.size must be a whole number of bytes from 0 to ${MAX_FILE_BYTES}.`);
  }
}

function checkPluginEntry(plugin, label, errors) {
  const required = [
    "id",
    "name",
    "description",
    "version",
    "pluginApiVersion",
    "capabilities",
    "features",
    "tags",
    "author",
    "license",
    "status",
  ];
  const optional = ["website", "commit", "path", "files", "images"];
  if (!checkKeys(plugin, label, required, optional, errors)) return;

  checkPattern(plugin.id, `${label} id`, ID_PATTERN, "must match ^[a-z0-9][a-z0-9_-]{1,63}$", errors);
  checkText(plugin.name, `${label} name`, 1, 80, errors);
  checkText(plugin.description, `${label} description`, 1, 500, errors);
  checkPattern(plugin.version, `${label} version`, VERSION_PATTERN, "must be a semantic version such as 1.2.0", errors);
  if (typeof plugin.version === "string" && plugin.version.length > 80) {
    errors.push(`${label} version must be at most 80 characters.`);
  }
  if (!Number.isInteger(plugin.pluginApiVersion) || plugin.pluginApiVersion < 1) {
    errors.push(`${label} pluginApiVersion must be a whole number of at least 1.`);
  }
  checkList(plugin.capabilities, `${label} capabilities`, 1, 6, (item, itemLabel) => {
    if (!CATALOG_CAPABILITIES.includes(item)) {
      errors.push(`${itemLabel} must be one of ${CATALOG_CAPABILITIES.join(", ")}, not ${JSON.stringify(item)}.`);
    }
  }, errors);
  checkList(plugin.features, `${label} features`, 1, 12, (item, itemLabel) => checkSlug(item, itemLabel, errors), errors);
  checkList(plugin.tags, `${label} tags`, 1, 12, (item, itemLabel) => checkSlug(item, itemLabel, errors), errors);
  if (checkKeys(plugin.author, `${label} author`, ["name", "url"], [], errors)) {
    checkText(plugin.author.name, `${label} author.name`, 1, 100, errors);
    checkHttpsUrl(plugin.author.url, `${label} author.url`, errors);
  }
  if (checkKeys(plugin.license, `${label} license`, ["name", "spdxId"], [], errors)) {
    checkText(plugin.license.name, `${label} license.name`, 1, 80, errors);
    checkPattern(plugin.license.spdxId, `${label} license.spdxId`, SPDX_PATTERN, "must be an SPDX identifier", errors);
  }
  if (has(plugin, "website")) checkHttpsUrl(plugin.website, `${label} website`, errors);
  if (!STATUSES.includes(plugin.status)) {
    errors.push(`${label} status must be one of ${STATUSES.join(", ")}, not ${JSON.stringify(plugin.status)}.`);
  }

  const hasFiles = has(plugin, "files");
  const hasImages = has(plugin, "images");
  if (plugin.status === "available" && !hasFiles) {
    errors.push(`${label} is available, so it must list its files.`);
  }
  if (plugin.status === "coming-soon" && hasFiles) {
    errors.push(`${label} is coming soon, so it must not list files.`);
  }
  if (hasFiles || hasImages) {
    if (!has(plugin, "commit")) errors.push(`${label} lists files or images, so it must name their commit.`);
    if (!has(plugin, "path")) errors.push(`${label} lists files or images, so it must name its path.`);
  }
  if (has(plugin, "commit")) {
    checkPattern(plugin.commit, `${label} commit`, COMMIT_PATTERN, "must be a full commit id, 40 or 64 lowercase hex characters", errors);
  }
  if (has(plugin, "path") && plugin.path !== ".") {
    const problem = relativePathProblem(plugin.path);
    if (problem) errors.push(`${label} path ${problem}: ${JSON.stringify(plugin.path)}.`);
  }

  let total = 0;
  if (hasFiles) {
    const files = plugin.files;
    if (!Array.isArray(files)) {
      errors.push(`${label} files must be an array.`);
    } else {
      if (files.length < 1 || files.length > 500) {
        errors.push(`${label} files must have 1 to 500 entries, not ${files.length}.`);
      }
      const paths = new Set();
      files.forEach((file, index) => {
        checkFileEntry(file, `${label} files[${index}]`, errors);
        if (!isRecord(file)) return;
        if (paths.has(file.path)) errors.push(`${label} files lists ${JSON.stringify(file.path)} twice.`);
        paths.add(file.path);
        if (Number.isInteger(file.size)) total += file.size;
      });
      if (!paths.has("plugin.json")) errors.push(`${label} files must include plugin.json.`);
    }
  }
  if (hasImages && checkKeys(plugin.images, `${label} images`, [], ["thumbnail", "hero"], errors)) {
    const kinds = Object.keys(plugin.images);
    if (kinds.length === 0) errors.push(`${label} images must have a thumbnail, a hero or both.`);
    for (const kind of kinds.filter((name) => name === "thumbnail" || name === "hero")) {
      const image = plugin.images[kind];
      const imageLabel = `${label} images.${kind}`;
      checkFileEntry(image, imageLabel, errors);
      if (!isRecord(image)) continue;
      const extension = typeof image.path === "string" ? image.path.split(".").pop() : "";
      if (!IMAGE_EXTENSIONS.includes(extension)) {
        errors.push(`${imageLabel}.path must end in ${IMAGE_EXTENSIONS.map((name) => `.${name}`).join(", ")}.`);
      }
      if (Number.isInteger(image.size)) {
        if (image.size > MAX_IMAGE_BYTES) errors.push(`${imageLabel} must be at most ${MAX_IMAGE_BYTES} bytes.`);
        total += image.size;
      }
    }
  }
  if (total > MAX_PLUGIN_BYTES) {
    errors.push(`${label} files add up to ${total} bytes, over the ${MAX_PLUGIN_BYTES} byte limit.`);
  }
}

/** Every way `source`, parsed from ajour.json, breaks the source format. Empty when it is valid. */
export function validateSource(source) {
  const errors = [];
  if (!checkKeys(source, "ajour.json", ["schemaVersion", "name", "plugins"], [], errors)) return errors;
  if (source.schemaVersion !== 1) errors.push("ajour.json schemaVersion must be 1.");
  checkText(source.name, "ajour.json name", 1, 80, errors);
  if (!Array.isArray(source.plugins)) {
    errors.push("ajour.json plugins must be an array.");
    return errors;
  }
  if (source.plugins.length < 1 || source.plugins.length > 100) {
    errors.push(`ajour.json plugins must have 1 to 100 entries, not ${source.plugins.length}.`);
  }
  const ids = new Set();
  source.plugins.forEach((plugin, index) => {
    const named = isRecord(plugin) && typeof plugin.id === "string";
    const label = `plugins[${index}]${named ? ` (${plugin.id})` : ""}`;
    checkPluginEntry(plugin, label, errors);
    if (!named) return;
    if (ids.has(plugin.id)) errors.push(`${label} id "${plugin.id}" is listed twice.`);
    ids.add(plugin.id);
  });
  return errors;
}

/** Every way `signature`, parsed from ajour.json.sig, breaks the format. Empty when it is valid. */
export function validateSignatureFile(signature) {
  const errors = [];
  const label = SIGNATURE_FILE;
  if (!checkKeys(signature, label, ["schemaVersion", "algorithm", "publicKey", "signature"], [], errors)) {
    return errors;
  }
  if (signature.schemaVersion !== 1) errors.push(`${label} schemaVersion must be 1.`);
  if (signature.algorithm !== "ed25519") errors.push(`${label} algorithm must be "ed25519".`);
  if (!decodeBase64(signature.publicKey, 32)) errors.push(`${label} publicKey must be the base64 of 32 bytes.`);
  if (!decodeBase64(signature.signature, 64)) errors.push(`${label} signature must be the base64 of 64 bytes.`);
  return errors;
}

// ---------------------------------------------------------------------------
// Keys and signatures.

/** The bytes of a canonical base64 string of exactly `length` bytes, or undefined. */
export function decodeBase64(value, length) {
  if (typeof value !== "string" || !BASE64_PATTERN.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== length || bytes.toString("base64") !== value) return undefined;
  return bytes;
}

/** A public key object from the 32 raw bytes of an Ed25519 public key. */
export function publicKeyFromRaw(raw) {
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
}

/** The 32 raw bytes of an Ed25519 key's public half. */
export function rawPublicKey(key) {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  const der = publicKey.export({ format: "der", type: "spki" });
  if (der.length !== 44 || !der.subarray(0, 12).equals(SPKI_ED25519_PREFIX)) {
    throw new SourceError("The key is not an Ed25519 key.");
  }
  return der.subarray(12);
}

/** The fingerprint people compare: SHA-256 of the raw key, first 16 hex characters in groups of four. */
export function fingerprint(rawKey) {
  const hex = createHash("sha256").update(rawKey).digest("hex").slice(0, 16);
  return hex.match(/.{4}/g).join(" ");
}

/** The ajour.json.sig content for the exact bytes of ajour.json. */
export function signSource(bytes, privateKey) {
  return {
    schemaVersion: 1,
    algorithm: "ed25519",
    publicKey: rawPublicKey(privateKey).toString("base64"),
    signature: sign(null, bytes, privateKey).toString("base64"),
  };
}

/** Checks a parsed ajour.json.sig over the exact bytes of ajour.json. Returns the raw public key. */
export function verifySourceSignature(bytes, signature) {
  const errors = validateSignatureFile(signature);
  if (errors.length > 0) throw new SourceError(errors.join("\n"));
  const rawKey = decodeBase64(signature.publicKey, 32);
  const valid = verify(null, bytes, publicKeyFromRaw(rawKey), decodeBase64(signature.signature, 64));
  if (!valid) {
    throw new SourceError(`${SIGNATURE_FILE} does not verify: ajour.json changed after it was signed, or it was signed by another key.`);
  }
  return rawKey;
}

function scryptKey(passphrase, salt, { N, r, p }) {
  return scryptSync(passphrase, salt, 32, { N, r, p, maxmem: SCRYPT_MAXMEM });
}

/** The encrypted signing key file content for an Ed25519 private key. */
export function encryptSigningKey(privateKey, passphrase, parameters = SCRYPT_PARAMETERS) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", scryptKey(passphrase, salt, parameters), iv);
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const encrypted = Buffer.concat([cipher.update(der), cipher.final()]);
  return {
    schemaVersion: 1,
    algorithm: "ed25519",
    publicKey: rawPublicKey(privateKey).toString("base64"),
    kdf: { name: "scrypt", N: parameters.N, r: parameters.r, p: parameters.p, salt: salt.toString("base64") },
    cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") },
    encryptedPrivateKey: encrypted.toString("base64"),
  };
}

/** The private key in a parsed signing key file. */
export function decryptSigningKey(keyFile, passphrase) {
  const errors = [];
  const label = "The signing key file";
  const keys = ["schemaVersion", "algorithm", "publicKey", "kdf", "cipher", "encryptedPrivateKey"];
  if (checkKeys(keyFile, label, keys, [], errors)) {
    if (keyFile.schemaVersion !== 1) errors.push(`${label} schemaVersion must be 1.`);
    if (keyFile.algorithm !== "ed25519") errors.push(`${label} algorithm must be "ed25519".`);
    if (!decodeBase64(keyFile.publicKey, 32)) errors.push(`${label} publicKey must be the base64 of 32 bytes.`);
    if (checkKeys(keyFile.kdf, `${label} kdf`, ["name", "N", "r", "p", "salt"], [], errors)) {
      const { name, N, r, p, salt } = keyFile.kdf;
      if (name !== "scrypt") errors.push(`${label} kdf name must be "scrypt".`);
      if (![N, r, p].every((value) => Number.isInteger(value) && value > 0)) {
        errors.push(`${label} kdf N, r and p must be positive whole numbers.`);
      }
      if (!decodeBase64(salt, 16)) errors.push(`${label} kdf salt must be the base64 of 16 bytes.`);
    }
    if (checkKeys(keyFile.cipher, `${label} cipher`, ["name", "iv", "tag"], [], errors)) {
      if (keyFile.cipher.name !== "aes-256-gcm") errors.push(`${label} cipher name must be "aes-256-gcm".`);
      if (!decodeBase64(keyFile.cipher.iv, 12)) errors.push(`${label} cipher iv must be the base64 of 12 bytes.`);
      if (!decodeBase64(keyFile.cipher.tag, 16)) errors.push(`${label} cipher tag must be the base64 of 16 bytes.`);
    }
    if (typeof keyFile.encryptedPrivateKey !== "string" || keyFile.encryptedPrivateKey === "") {
      errors.push(`${label} encryptedPrivateKey must be base64.`);
    }
  }
  if (errors.length > 0) throw new SourceError(errors.join("\n"));

  const { N, r, p } = keyFile.kdf;
  let der;
  try {
    const key = scryptKey(passphrase, Buffer.from(keyFile.kdf.salt, "base64"), { N, r, p });
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(keyFile.cipher.iv, "base64"));
    decipher.setAuthTag(Buffer.from(keyFile.cipher.tag, "base64"));
    der = Buffer.concat([
      decipher.update(Buffer.from(keyFile.encryptedPrivateKey, "base64")),
      decipher.final(),
    ]);
  } catch {
    throw new SourceError("The passphrase is wrong, or the signing key file is damaged.");
  }
  const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  if (!rawPublicKey(privateKey).equals(Buffer.from(keyFile.publicKey, "base64"))) {
    throw new SourceError("The signing key file's publicKey does not match its private key.");
  }
  return privateKey;
}

// ---------------------------------------------------------------------------
// tar and .ajour-connector archives.

function writeOctal(header, value, offset, length) {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function splitTarName(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
    const prefix = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (name !== "" && Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new SourceError(`${path} is too long for a tar header.`);
}

function tarHeader(path, size, mode, type) {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitTarName(path);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, mode, 100, 8);
  writeOctal(header, 0, 108, 8); // uid
  writeOctal(header, 0, 116, 8); // gid
  writeOctal(header, size, 124, 12);
  writeOctal(header, 0, 136, 12); // mtime, left out so archives are reproducible
  header.fill(0x20, 148, 156); // the checksum counts its own field as spaces
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(prefix, 345, 155, "utf8");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

/**
 * A ustar archive of `entries`, in order: `{ path, data }` for a file and
 * `{ path, directory: true }` for a directory. Paths use "/".
 */
export function createTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    if (entry.directory) {
      blocks.push(tarHeader(`${entry.path.replace(/\/$/, "")}/`, 0, 0o755, "5"));
      continue;
    }
    const data = Buffer.from(entry.data);
    blocks.push(tarHeader(entry.path, data.length, 0o644, "0"), data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** A gzipped tar of `files` (`{ path, data }`) with their folders, the .ajour-connector format. */
export function createConnectorArchive(files) {
  const directories = new Set();
  for (const file of files) {
    const segments = file.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  const entries = [
    ...[...directories].map((path) => ({ path, directory: true, key: `${path}/` })),
    ...files.map((file) => ({ ...file, key: file.path })),
  ].sort((left, right) => compareText(left.key, right.key));
  return gzipSync(createTar(entries), { level: 9 });
}

// ---------------------------------------------------------------------------
// git.

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runGit(root, args, { input, binary = false } = {}) {
  const result = spawnSync("git", ["--literal-pathspecs", ...args], {
    cwd: root,
    input: input === undefined ? undefined : Buffer.from(input, "utf8"),
    encoding: binary ? "buffer" : "utf8",
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw new SourceError(`Could not run git: ${result.error.message}`);
  return result;
}

function git(root, args, options) {
  const result = runGit(root, args, options);
  if (result.status !== 0) {
    throw new SourceError(`git ${args.join(" ")} failed: ${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

/** The root of the git working tree that holds `cwd`. */
export function repositoryRoot(cwd = process.cwd()) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new SourceError("Run this inside the plugin source's git repository.");
  }
  return resolve(result.stdout.trim());
}

/** Tracked files under `prefix` at `commit`: Map of path below the prefix to { mode, type, oid, size }. */
function treeEntries(root, commit, prefix) {
  const args = ["ls-tree", "-r", "-z", "-l", commit];
  if (prefix !== ".") args.push("--", prefix);
  const output = git(root, args);
  const entries = new Map();
  for (const record of output.split("\0")) {
    if (record === "") continue;
    const match = /^(\d+) (\w+) ([0-9a-f]+) +(-|\d+)\t(.*)$/s.exec(record);
    if (!match) throw new SourceError(`Unexpected git ls-tree output: ${record}`);
    const [, mode, type, oid, size, path] = match;
    const below = prefix === "." ? path : path.slice(prefix.length + 1);
    entries.set(below, { mode, type, oid, size: size === "-" ? undefined : Number(size) });
  }
  return entries;
}

/** The content of each blob in `oids`. */
function readBlobs(root, oids) {
  const unique = [...new Set(oids)];
  const blobs = new Map();
  if (unique.length === 0) return blobs;
  const output = git(root, ["cat-file", "--batch"], { input: `${unique.join("\n")}\n`, binary: true });
  let offset = 0;
  for (const oid of unique) {
    const newline = output.indexOf(0x0a, offset);
    const header = output.subarray(offset, newline).toString("utf8");
    const [, type, size] = header.split(" ");
    if (type !== "blob") throw new SourceError(`git object ${oid} is not a file (${header}).`);
    const start = newline + 1;
    blobs.set(oid, output.subarray(start, start + Number(size)));
    offset = start + Number(size) + 1;
  }
  return blobs;
}

function blobAt(root, ref, path) {
  const result = runGit(root, ["cat-file", "blob", `${ref}:${path}`], { binary: true });
  return result.status === 0 ? result.stdout : undefined;
}

function shortCommit(commit) {
  return commit.slice(0, 7);
}

// ---------------------------------------------------------------------------
// Plugins in the repository.

function joinPath(pluginPath, file) {
  return pluginPath === "." ? file : `${pluginPath}/${file}`;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new SourceError(`${label} is not valid JSON: ${error.message}`);
  }
}

/** Plugin paths in the working tree: "." when the root has a plugin.json, then plugins/<folder>. */
export function workingPluginPaths(root) {
  const paths = existsSync(join(root, "plugin.json")) ? ["."] : [];
  const pluginsDirectory = join(root, "plugins");
  if (existsSync(pluginsDirectory)) {
    for (const entry of readdirSync(pluginsDirectory, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(pluginsDirectory, entry.name, "plugin.json"))) {
        paths.push(`plugins/${entry.name}`);
      }
    }
  }
  return paths.sort(compareText);
}

function committedPluginPaths(root, commit) {
  const output = git(root, ["ls-tree", "-r", "-z", "--name-only", commit]);
  return output
    .split("\0")
    .filter((path) => path === "plugin.json" || /^plugins\/[^/]+\/plugin\.json$/.test(path))
    .map((path) => (path === "plugin.json" ? "." : path.slice(0, -"/plugin.json".length)))
    .sort(compareText);
}

/** The plugin path for a folder named on the command line: "jira", "plugins/jira" or ".". */
export function pluginPathFor(root, folder) {
  const candidates =
    folder === "." ? ["."] : [`plugins/${folder}`, folder.replace(/\\/g, "/").replace(/\/$/, "")];
  for (const candidate of candidates) {
    if (existsSync(join(root, candidate, "plugin.json"))) return candidate;
  }
  throw new SourceError(`No plugin "${folder}": there is no plugins/${folder}/plugin.json.`);
}

/** The listing in a plugin's package.json "ajour" field, checked enough to build ajour.json from it. */
function readListing(packageJson, pluginPath) {
  const label = `${joinPath(pluginPath, "package.json")} "ajour"`;
  const listing = packageJson?.ajour;
  if (!isRecord(listing)) {
    throw new SourceError(`${joinPath(pluginPath, "package.json")} needs an "ajour" field with the plugin's listing.`);
  }
  const allowed = pluginPath === "." ? [...LISTING_KEYS, "sourceName"] : LISTING_KEYS;
  const errors = [];
  for (const key of Object.keys(listing)) {
    if (!allowed.includes(key)) errors.push(`${label} has an unknown key "${key}".`);
  }
  if (!Array.isArray(listing.files) || listing.files.length === 0) {
    errors.push(`${label} needs "files", the files and folders to publish, such as ["plugin.json", "package.json", "src"].`);
  } else {
    for (const entry of listing.files) {
      const problem = relativePathProblem(entry);
      if (problem) errors.push(`${label} files entry ${JSON.stringify(entry)} ${problem}.`);
    }
  }
  if (listing.images !== undefined) {
    if (!isRecord(listing.images)) {
      errors.push(`${label} images must map "thumbnail" or "hero" to a file path.`);
    } else {
      for (const [kind, path] of Object.entries(listing.images)) {
        const problem = relativePathProblem(path);
        if (problem) errors.push(`${label} images.${kind} ${problem}.`);
      }
    }
  }
  if (errors.length > 0) throw new SourceError(errors.join("\n"));
  return listing;
}

/** The source's capability names for a plugin.json capabilities object. */
export function catalogCapabilities(capabilities, label = "plugin.json") {
  if (!isRecord(capabilities)) throw new SourceError(`${label} capabilities must be an object.`);
  const names = [];
  for (const key of Object.keys(capabilities)) {
    if (!has(PLUGIN_CAPABILITIES, key)) {
      throw new SourceError(`${label} declares the capability "${key}", which ajour.json has no name for.`);
    }
    const name = PLUGIN_CAPABILITIES[key];
    if (name !== null && !names.includes(name)) names.push(name);
  }
  return names;
}

function sameNames(left, right) {
  return left.length === right.length && [...left].sort().join("\n") === [...right].sort().join("\n");
}

/**
 * Problems with what a plugin publishes that the source format leaves to
 * Ajour: the entrypoint must be a published .ts, .mts, .js or .mjs file, and
 * .ts and .js files need a published package.json with "type": "module", so
 * Node loads them as ES modules. `paths` are the published paths.
 */
export function publishedFileProblems({ label, manifest, packageJson, paths }) {
  const problems = [];
  const published = new Set(paths);
  if (packageJson !== undefined && packageJson.version !== manifest.version) {
    problems.push(`${label}: package.json has version ${packageJson.version} but plugin.json has ${manifest.version}. Keep them the same.`);
  }
  const entrypoint = manifest.entrypoint;
  if (entrypoint !== undefined) {
    const problem = relativePathProblem(entrypoint);
    if (problem) {
      problems.push(`${label}: plugin.json entrypoint ${problem}.`);
    } else {
      if (!ENTRYPOINT_EXTENSIONS.some((extension) => entrypoint.endsWith(extension))) {
        problems.push(`${label}: plugin.json entrypoint must be a ${ENTRYPOINT_EXTENSIONS.join(", ")} file, not ${entrypoint}.`);
      }
      if (!published.has(entrypoint)) {
        problems.push(`${label}: the entrypoint ${entrypoint} is not among the published files. Add it to "ajour.files".`);
      }
    }
  }
  const needsModuleType =
    entrypoint !== undefined &&
    [entrypoint, ...paths].some((path) => /\.(?:ts|js)$/.test(path) && !path.endsWith(".d.ts"));
  if (needsModuleType) {
    if (!published.has("package.json")) {
      problems.push(`${label}: it publishes .ts or .js files, so it must publish a package.json with "type": "module". Add "package.json" to "ajour.files".`);
    } else if (packageJson?.type !== "module") {
      problems.push(`${label}: its package.json must have "type": "module", so Node loads its .ts and .js files as ES modules.`);
    }
  }
  return problems;
}

function selectEntries(paths, entries) {
  return paths.filter((path) => entries.some((entry) => path === entry || path.startsWith(`${entry}/`)));
}

/**
 * The files a plugin publishes from the working tree, tracked or not yet
 * tracked but never ignored, for archives and the smoke import.
 */
export function workingPlugin(root, pluginPath) {
  const directory = join(root, pluginPath);
  const manifest = parseJson(readFileSync(join(directory, "plugin.json")), joinPath(pluginPath, "plugin.json"));
  const packageJsonPath = join(directory, "package.json");
  const packageJson = existsSync(packageJsonPath)
    ? parseJson(readFileSync(packageJsonPath), joinPath(pluginPath, "package.json"))
    : undefined;
  const listing = readListing(packageJson, pluginPath);
  const entries = [...new Set(["plugin.json", ...listing.files])];
  const pathspecs = entries.map((entry) => joinPath(pluginPath, entry));
  const output = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...pathspecs]);
  const paths = [...new Set(output.split("\0").filter(Boolean))]
    .filter((path) => existsSync(join(root, path)))
    .map((path) => (pluginPath === "." ? path : path.slice(pluginPath.length + 1)))
    .sort(compareText);
  for (const entry of entries) {
    if (!paths.some((path) => path === entry || path.startsWith(`${entry}/`))) {
      throw new SourceError(`${joinPath(pluginPath, entry)}, listed in "ajour.files", does not exist.`);
    }
  }
  const files = [];
  let total = 0;
  for (const path of paths) {
    const problem = relativePathProblem(path);
    if (problem) throw new SourceError(`${joinPath(pluginPath, path)}: the path ${problem}.`);
    const absolute = join(directory, path);
    const stat = lstatSync(absolute);
    if (!stat.isFile()) throw new SourceError(`${joinPath(pluginPath, path)} is not a regular file.`);
    if (stat.size > MAX_FILE_BYTES) throw new SourceError(`${joinPath(pluginPath, path)} is over ${MAX_FILE_BYTES} bytes.`);
    total += stat.size;
    files.push({ path, absolute, size: stat.size });
  }
  if (files.length > 500) throw new SourceError(`${pluginPath} publishes ${files.length} files, over the limit of 500.`);
  if (total > MAX_PLUGIN_BYTES) throw new SourceError(`${pluginPath} publishes ${total} bytes, over the ${MAX_PLUGIN_BYTES} byte limit.`);
  const problems = publishedFileProblems({ label: pluginPath, manifest, packageJson, paths });
  if (problems.length > 0) throw new SourceError(problems.join("\n"));
  return { pluginPath, directory, manifest, packageJson, listing, files };
}

/** The ajour.json entry for the plugin at `pluginPath`, from its files at `commit`. */
function pluginEntryAt(root, commit, pluginPath) {
  const manifestBytes = blobAt(root, commit, joinPath(pluginPath, "plugin.json"));
  const packageBytes = blobAt(root, commit, joinPath(pluginPath, "package.json"));
  const manifest = parseJson(manifestBytes, joinPath(pluginPath, "plugin.json"));
  const packageJson = packageBytes ? parseJson(packageBytes, joinPath(pluginPath, "package.json")) : undefined;
  const listing = readListing(packageJson, pluginPath);
  const label = pluginPath;

  const entry = {
    id: manifest.id,
    name: listing.name ?? manifest.displayName,
    description: listing.description ?? manifest.description,
    version: manifest.version,
    pluginApiVersion: manifest.apiVersion,
    capabilities: catalogCapabilities(manifest.capabilities, joinPath(pluginPath, "plugin.json")),
    features: listing.features,
    tags: listing.tags,
    author: listing.author,
    license: listing.license,
    ...(listing.website !== undefined ? { website: listing.website } : {}),
    status: listing.status,
  };
  const publishesFiles = listing.status !== "coming-soon";
  if (!publishesFiles && listing.images === undefined) return entry;

  entry.commit = commit;
  entry.path = pluginPath;
  const tree = treeEntries(root, commit, pluginPath);
  const describe = (path) => {
    const item = tree.get(path);
    if (!item) throw new SourceError(`${joinPath(pluginPath, path)} is not tracked at ${shortCommit(commit)}.`);
    if (item.type !== "blob" || item.mode === "120000") {
      throw new SourceError(`${joinPath(pluginPath, path)} is not a regular file. Ajour installs regular files only.`);
    }
    const problem = relativePathProblem(path);
    if (problem) throw new SourceError(`${joinPath(pluginPath, path)}: the path ${problem}.`);
    return { path, oid: item.oid, size: item.size };
  };

  const described = [];
  if (publishesFiles) {
    const entries = [...new Set(["plugin.json", ...listing.files])];
    const paths = selectEntries([...tree.keys()], entries).sort(compareText);
    for (const listed of entries) {
      if (!paths.some((path) => path === listed || path.startsWith(`${listed}/`))) {
        throw new SourceError(`${joinPath(pluginPath, listed)}, listed in "ajour.files", is not tracked at ${shortCommit(commit)}.`);
      }
    }
    described.push(...paths.map(describe));
    const problems = publishedFileProblems({ label, manifest, packageJson, paths });
    if (problems.length > 0) throw new SourceError(problems.join("\n"));
  }
  const images = Object.entries(listing.images ?? {}).map(([kind, path]) => [kind, describe(path)]);
  const blobs = readBlobs(root, [...described, ...images.map(([, image]) => image)].map((file) => file.oid));
  const fileEntry = ({ path, oid }) => ({ path, sha256: sha256(blobs.get(oid)), size: blobs.get(oid).length });
  if (publishesFiles) entry.files = described.map(fileEntry);
  if (images.length > 0) entry.images = Object.fromEntries(images.map(([kind, image]) => [kind, fileEntry(image)]));
  return entry;
}

/** ajour.json for every plugin at `commit`, unwritten. */
export function buildSource(root, commit) {
  const rootPackage = blobAt(root, commit, "package.json");
  const sourceName = rootPackage ? parseJson(rootPackage, "package.json").ajour?.sourceName : undefined;
  if (typeof sourceName !== "string") {
    throw new SourceError('The root package.json needs "ajour": { "sourceName": "<the source\'s display name>" }.');
  }
  const pluginPaths = committedPluginPaths(root, commit);
  if (pluginPaths.length === 0) throw new SourceError("There is no plugins/<folder>/plugin.json to release.");
  const source = {
    schemaVersion: 1,
    name: sourceName,
    plugins: pluginPaths.map((pluginPath) => pluginEntryAt(root, commit, pluginPath)),
  };
  const errors = validateSource(source);
  if (errors.length > 0) throw new SourceError(`The listing would make an invalid ajour.json:\n${errors.join("\n")}`);
  return source;
}

/** The bytes Ajour reads: 2-space JSON and a trailing newline. */
export function serializeSource(source) {
  return Buffer.from(`${JSON.stringify(source, null, 2)}\n`, "utf8");
}

function filesKey(plugin) {
  return JSON.stringify({ files: plugin.files ?? [], images: plugin.images ?? {} });
}

/** Plugins whose files changed since `previous` but kept their version. */
export function unbumpedPlugins(previous, next) {
  const before = new Map((previous?.plugins ?? []).filter(isRecord).map((plugin) => [plugin.id, plugin]));
  return next.plugins.filter((plugin) => {
    const old = before.get(plugin.id);
    if (!old || old.version !== plugin.version) return false;
    if (old.files === undefined || plugin.files === undefined) return false;
    return filesKey(old) !== filesKey(plugin);
  });
}

// ---------------------------------------------------------------------------
// Checking a source against its repository.

/**
 * Checks ajour.json bytes against the format and against the repository: each
 * file at its entry's commit, and plugin.json there. With signature bytes,
 * checks the signature too. Returns what it checked, or throws a SourceError
 * listing every problem.
 */
export function checkSource(root, { bytes, signatureBytes, publicKey } = {}) {
  const errors = [];
  const notes = [];
  if (bytes.length > MAX_SOURCE_BYTES) {
    throw new SourceError(`ajour.json is ${bytes.length} bytes, over the ${MAX_SOURCE_BYTES} byte limit.`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SourceError("ajour.json is not UTF-8.");
  }
  let source;
  try {
    source = JSON.parse(text);
  } catch (error) {
    throw new SourceError(`ajour.json is not valid JSON: ${error.message}`);
  }
  const formatErrors = validateSource(source);
  if (formatErrors.length > 0) throw new SourceError(formatErrors.join("\n"));

  for (const plugin of source.plugins) {
    const label = `${plugin.id} ${plugin.version}`;
    if (plugin.commit === undefined) {
      notes.push(`${label}: ${plugin.status}, no files.`);
      continue;
    }
    const commit = plugin.commit;
    if (runGit(root, ["cat-file", "-e", `${commit}^{commit}`]).status !== 0) {
      errors.push(`${label}: commit ${commit} is not in this clone. Fetch the full history (fetch-depth: 0 in CI).`);
      continue;
    }
    if (runGit(root, ["merge-base", "--is-ancestor", commit, "HEAD"]).status !== 0) {
      errors.push(`${label}: commit ${shortCommit(commit)} is not in the history of HEAD. Release again from a commit on the default branch.`);
    }
    const tree = treeEntries(root, commit, plugin.path);
    const listed = [...(plugin.files ?? []), ...Object.values(plugin.images ?? {})];
    const found = [];
    for (const file of listed) {
      const item = tree.get(file.path);
      const where = `${joinPath(plugin.path, file.path)} at ${shortCommit(commit)}`;
      if (!item) {
        errors.push(`${label}: ${where} does not exist.`);
      } else if (item.type !== "blob" || item.mode === "120000") {
        errors.push(`${label}: ${where} is not a regular file.`);
      } else if (item.size !== file.size) {
        errors.push(`${label}: ${where} is ${item.size} bytes, but ajour.json says ${file.size}.`);
      } else {
        found.push({ file, oid: item.oid });
      }
    }
    const blobs = readBlobs(root, found.map(({ oid }) => oid));
    for (const { file, oid } of found) {
      if (sha256(blobs.get(oid)) !== file.sha256) {
        errors.push(`${label}: ${joinPath(plugin.path, file.path)} at ${shortCommit(commit)} does not match its sha256 in ajour.json.`);
      }
    }

    const manifestItem = tree.get("plugin.json");
    if (!manifestItem) {
      errors.push(`${label}: ${joinPath(plugin.path, "plugin.json")} does not exist at ${shortCommit(commit)}.`);
      continue;
    }
    let manifest;
    let packageJson;
    try {
      manifest = parseJson(readBlobs(root, [manifestItem.oid]).get(manifestItem.oid), "plugin.json");
      const packageItem = tree.get("package.json");
      if (packageItem) packageJson = parseJson(readBlobs(root, [packageItem.oid]).get(packageItem.oid), "package.json");
    } catch (error) {
      errors.push(`${label}: ${error.message}`);
      continue;
    }
    if (manifest.id !== plugin.id) errors.push(`${label}: plugin.json at ${shortCommit(commit)} has id ${JSON.stringify(manifest.id)}.`);
    if (manifest.version !== plugin.version) {
      errors.push(`${label}: plugin.json at ${shortCommit(commit)} has version ${JSON.stringify(manifest.version)}.`);
    }
    if (manifest.apiVersion !== plugin.pluginApiVersion) {
      errors.push(`${label}: plugin.json at ${shortCommit(commit)} has apiVersion ${JSON.stringify(manifest.apiVersion)}, but ajour.json says pluginApiVersion ${plugin.pluginApiVersion}.`);
    }
    try {
      const capabilities = catalogCapabilities(manifest.capabilities);
      if (!sameNames(capabilities, plugin.capabilities)) {
        errors.push(`${label}: plugin.json at ${shortCommit(commit)} declares ${capabilities.join(", ") || "no capabilities"}, but ajour.json lists ${plugin.capabilities.join(", ")}.`);
      }
    } catch (error) {
      errors.push(`${label}: ${error.message}`);
    }
    if (plugin.files !== undefined) {
      const published = plugin.files.map((file) => file.path);
      const listedPackage = published.includes("package.json") ? packageJson : undefined;
      errors.push(...publishedFileProblems({ label, manifest, packageJson: listedPackage, paths: published }));
    }
    notes.push(`${label}: ${listed.length} files match ${plugin.path} at ${shortCommit(commit)}.`);
  }

  let signedBy;
  if (signatureBytes !== undefined && signatureBytes.length > MAX_SIGNATURE_BYTES) {
    errors.push(`${SIGNATURE_FILE} is ${signatureBytes.length} bytes, over the ${MAX_SIGNATURE_BYTES} byte limit.`);
  } else if (signatureBytes !== undefined) {
    try {
      const signature = parseJson(signatureBytes, SIGNATURE_FILE);
      signedBy = verifySourceSignature(bytes, signature);
      if (publicKey !== undefined) {
        const expected = decodeBase64(publicKey, 32);
        if (!expected) errors.push("--public-key must be the base64 of a 32-byte Ed25519 public key.");
        else if (!expected.equals(signedBy)) {
          errors.push(`${SIGNATURE_FILE} is signed by key ${fingerprint(signedBy)}, not by ${fingerprint(expected)}.`);
        }
      }
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
      const hint = bytes.includes(0x0d)
        ? ' ajour.json has CRLF line endings here; git may have changed them. Add "ajour.json -text" to .gitattributes and check it out again.'
        : "";
      errors.push(`${error.message}${hint}`);
    }
  } else if (publicKey !== undefined) {
    errors.push(`ajour.json is unsigned, but --public-key asks for a signature by that key.`);
  }

  if (errors.length > 0) throw new SourceError(errors.join("\n"));
  return { source, notes, signedBy };
}

// ---------------------------------------------------------------------------
// Commands.

/** Asks for a passphrase on the terminal without echoing it. */
export function promptHidden(question) {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    return Promise.reject(new SourceError(`Set ${PASSPHRASE_VARIABLE}, or run this in a terminal to type the passphrase.`));
  }
  stderr.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolvePrompt, reject) => {
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n" || character === "\u0004") {
          finish();
          resolvePrompt(value);
          return;
        }
        if (character === "\u0003") {
          finish();
          reject(new SourceError("Cancelled."));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = Array.from(value).slice(0, -1).join("");
        } else {
          value += character;
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function readPassphrase({ env, prompt, confirm }) {
  const fromEnvironment = env[PASSPHRASE_VARIABLE];
  if (fromEnvironment !== undefined && fromEnvironment !== "") return fromEnvironment;
  const passphrase = await prompt("Signing key passphrase: ");
  if (confirm) {
    const again = await prompt("Type it again: ");
    if (again !== passphrase) throw new SourceError("The passphrases do not match.");
  }
  if (passphrase === "") throw new SourceError("The passphrase is empty.");
  return passphrase;
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** Writes a new encrypted signing key file and returns its public key and fingerprint. */
export async function keygen({ out, cwd = process.cwd(), env = process.env, prompt = promptHidden, log = console.log } = {}) {
  const target = resolve(cwd, out ?? DEFAULT_KEY_FILE);
  if (existsSync(target)) {
    throw new SourceError(`${target} already exists. Refusing to overwrite a signing key.`);
  }
  let root;
  try {
    root = repositoryRoot(cwd);
  } catch {
    root = undefined;
  }
  if (root && isInside(root, target)) {
    throw new SourceError(`${target} is inside the repository ${root}. Keep the signing key outside it.`);
  }
  const passphrase = await readPassphrase({ env, prompt, confirm: true });
  const { privateKey } = generateKeyPairSync("ed25519");
  const keyFile = encryptSigningKey(privateKey, passphrase);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, `${JSON.stringify(keyFile, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const publicKey = keyFile.publicKey;
  const print = fingerprint(Buffer.from(publicKey, "base64"));
  log(`Wrote the encrypted signing key to ${target}.`);
  log(`Public key:  ${publicKey}`);
  log(`Fingerprint: ${print}`);
  log("Keep the file out of any repository and out of cloud-synced folders. Without the passphrase it is useless; with it, anyone can sign as you.");
  return { file: target, publicKey, fingerprint: print };
}

function dirtyPaths(root) {
  const output = git(root, ["status", "--porcelain=v1", "-z"]);
  const records = output.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    paths.push(record.slice(3));
    if (record[0] === "R" || record[0] === "C") index += 1; // the rename's source follows
  }
  return paths.filter((path) => path !== SOURCE_FILE && path !== SIGNATURE_FILE);
}

/**
 * Writes ajour.json for HEAD and, unless `unsigned`, signs it into
 * ajour.json.sig. Refuses a dirty tree, a HEAD no remote branch has, and a
 * plugin whose files changed without a new version.
 */
export async function release({
  cwd = process.cwd(),
  keyFile,
  unsigned = false,
  env = process.env,
  prompt = promptHidden,
  log = console.log,
} = {}) {
  const root = repositoryRoot(cwd);
  const dirty = dirtyPaths(root);
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 10).join(", ");
    throw new SourceError(`Commit or stash your changes first. The working tree has changes: ${shown}${dirty.length > 10 ? ", …" : ""}.`);
  }
  const commit = git(root, ["rev-parse", "HEAD"]).trim();
  const remoteBranches = git(root, ["branch", "-r", "--contains", commit]).trim();
  if (remoteBranches === "") {
    throw new SourceError(`HEAD (${shortCommit(commit)}) is on no remote branch. Push it first: ajour.json pins this commit, and Ajour fetches the plugins' files from it.`);
  }

  const source = buildSource(root, commit);
  const previousBytes = blobAt(root, "HEAD", SOURCE_FILE);
  if (previousBytes) {
    const previous = parseJson(previousBytes, `${SOURCE_FILE} at HEAD`);
    const unbumped = unbumpedPlugins(previous, source);
    if (unbumped.length > 0) {
      const names = unbumped.map((plugin) => `${plugin.path} (${plugin.id} ${plugin.version})`).join(", ");
      throw new SourceError(`These plugins changed since the last release but kept their version: ${names}. Bump the version in their plugin.json and package.json.`);
    }
  }

  let privateKey;
  let keyPath;
  if (!unsigned) {
    keyPath = resolve(cwd, keyFile ?? DEFAULT_KEY_FILE);
    if (!existsSync(keyPath)) {
      throw new SourceError(`There is no signing key at ${keyPath}. Run "just keygen", pass --key <file>, or release with --unsigned.`);
    }
    const parsedKey = parseJson(readFileSync(keyPath), keyPath);
    privateKey = decryptSigningKey(parsedKey, await readPassphrase({ env, prompt, confirm: false }));
  }

  const bytes = serializeSource(source);
  const sourcePath = join(root, SOURCE_FILE);
  const signaturePath = join(root, SIGNATURE_FILE);
  const signatureWasTracked = blobAt(root, "HEAD", SIGNATURE_FILE) !== undefined;
  writeFileSync(sourcePath, bytes);
  let signatureBytes;
  if (privateKey) {
    signatureBytes = Buffer.from(`${JSON.stringify(signSource(bytes, privateKey), null, 2)}\n`, "utf8");
    writeFileSync(signaturePath, signatureBytes);
  } else {
    rmSync(signaturePath, { force: true });
  }
  const { signedBy } = checkSource(root, { bytes, signatureBytes });

  log(`Wrote ${SOURCE_FILE}, "${source.name}", for commit ${shortCommit(commit)}:`);
  for (const plugin of source.plugins) {
    const files = plugin.files ? `, ${plugin.files.length} files` : "";
    log(`  ${plugin.id} ${plugin.version} (${plugin.status}${files})`);
  }
  if (signedBy) {
    log(`Signed it into ${SIGNATURE_FILE} with key ${fingerprint(signedBy)} from ${keyPath}.`);
  } else {
    log(`Left it unsigned${signatureWasTracked ? ` and removed the old ${SIGNATURE_FILE}` : ""}. Ajour shows its plugins as unsigned.`);
  }
  const add = signedBy || signatureWasTracked ? `${SOURCE_FILE} ${SIGNATURE_FILE}` : SOURCE_FILE;
  log("Next, commit and push it:");
  log(`  git add ${add} && git commit && git push`);
  return { source, bytes, commit, signedBy };
}

/** Checks the repository's ajour.json and ajour.json.sig. Returns false when there is no ajour.json. */
export function verifyRepository({ cwd = process.cwd(), publicKey, log = console.log } = {}) {
  const root = repositoryRoot(cwd);
  const sourcePath = join(root, SOURCE_FILE);
  const signaturePath = join(root, SIGNATURE_FILE);
  if (!existsSync(sourcePath)) {
    if (existsSync(signaturePath)) throw new SourceError(`There is a ${SIGNATURE_FILE} but no ${SOURCE_FILE}.`);
    log(`There is no ${SOURCE_FILE} at the repository root yet, so there is nothing to check.`);
    return false;
  }
  const bytes = readFileSync(sourcePath);
  const signatureBytes = existsSync(signaturePath) ? readFileSync(signaturePath) : undefined;
  const { source, notes, signedBy } = checkSource(root, { bytes, signatureBytes, publicKey });
  log(`${SOURCE_FILE}, "${source.name}", lists ${source.plugins.length} plugins and follows the format.`);
  for (const note of notes) log(`  ${note}`);
  log(signedBy ? `Signed by key ${fingerprint(signedBy)}.` : "Unsigned: there is no ajour.json.sig.");
  return true;
}

/** Writes <plugin>/package/<id>-<version>.ajour-connector from the working tree and returns its path. */
export function packagePlugin({ cwd = process.cwd(), folder, log = console.log } = {}) {
  if (!folder) throw new SourceError("Name the plugin folder to package, for example: package jira");
  const root = repositoryRoot(cwd);
  const plugin = workingPlugin(root, pluginPathFor(root, folder));
  const { id, version } = plugin.manifest;
  if (typeof id !== "string" || !ID_PATTERN.test(id) || typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new SourceError(`${plugin.pluginPath}/plugin.json needs a valid id and version.`);
  }
  const archive = createConnectorArchive(
    plugin.files.map((file) => ({ path: file.path, data: readFileSync(file.absolute) })),
  );
  const outputDirectory = join(plugin.directory, "package");
  const output = join(outputDirectory, `${id}-${version}.ajour-connector`);
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(output, archive);
  log(`Wrote ${output} (${plugin.files.length} files). Install it in Ajour with Settings, Plugins, Install from file.`);
  return output;
}

const USAGE = `Usage:
  node scripts/ajour-source.mjs keygen [--out <file>]
  node scripts/ajour-source.mjs release [--key <file>] [--unsigned]
  node scripts/ajour-source.mjs verify [--public-key <base64>]
  node scripts/ajour-source.mjs package <folder>`;

export async function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case "keygen": {
      const { values } = parseArgs({ args, options: { out: { type: "string" } } });
      await keygen({ out: values.out });
      return;
    }
    case "release": {
      const { values } = parseArgs({
        args,
        options: { key: { type: "string" }, unsigned: { type: "boolean", default: false } },
      });
      if (values.unsigned && values.key) throw new SourceError("--key and --unsigned do not go together.");
      await release({ keyFile: values.key, unsigned: values.unsigned });
      return;
    }
    case "verify": {
      const { values } = parseArgs({ args, options: { "public-key": { type: "string" } } });
      verifyRepository({ publicKey: values["public-key"] });
      return;
    }
    case "package": {
      const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
      if (positionals.length !== 1) throw new SourceError(USAGE);
      packagePlugin({ folder: positionals[0] });
      return;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      throw new SourceError(`Unknown command "${command}".\n${USAGE}`);
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).catch((error) => {
    if (error instanceof SourceError || error?.code?.startsWith?.("ERR_PARSE_ARGS")) {
      console.error(error.message);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });
}
