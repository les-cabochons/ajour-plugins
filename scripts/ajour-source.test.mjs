// Tests for ajour-source.mjs. Each test builds a throwaway git repository and
// signing key in a temporary folder; nothing touches this repository or the
// real signing key.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  createConnectorArchive,
  createTar,
  decryptSigningKey,
  encryptSigningKey,
  fingerprint,
  keygen,
  packagePlugin,
  PASSPHRASE_VARIABLE,
  publicKeyFromRaw,
  rawPublicKey,
  relativePathProblem,
  release,
  signSource,
  SourceError,
  validateSignatureFile,
  validateSource,
  verifyRepository,
  verifySourceSignature,
} from "./ajour-source.mjs";

const script = fileURLToPath(new URL("./ajour-source.mjs", import.meta.url));
const passphrase = "correct horse battery staple, but longer";
const env = { [PASSPHRASE_VARIABLE]: passphrase };
const quiet = () => {};
const noPrompt = () => Promise.reject(new Error("The test asked for a passphrase on the terminal."));
const scratch = mkdtempSync(join(tmpdir(), "ajour-source-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function freshDirectory(name) {
  counter += 1;
  const directory = join(scratch, `${counter}-${name}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const listing = {
  features: ["greeting"],
  tags: ["hello", "example"],
  author: { name: "Test Author", url: "https://example.com/author" },
  license: { name: "MIT License", spdxId: "MIT" },
  website: "https://example.com/hello",
  status: "available",
  files: ["plugin.json", "package.json", "src"],
};

function writeHello(root, version = "1.0.0") {
  write(root, "plugins/hello/plugin.json", {
    id: "hello",
    version,
    apiVersion: 3,
    displayName: "Hello",
    description: "Says hello.",
    entrypoint: "src/plugin.ts",
    capabilities: { connector: {}, projectProperties: {}, taskProperties: {} },
  });
  write(root, "plugins/hello/package.json", {
    name: "hello",
    version,
    private: true,
    type: "module",
    ajour: listing,
  });
}

/** A git repository with two plugins, committed, with HEAD on a fake remote branch. */
function makeRepository() {
  const root = freshDirectory("repo");
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.autocrlf", "false");
  write(root, "package.json", { private: true, type: "module", ajour: { sourceName: "Test plugins" } });
  writeHello(root);
  write(root, "plugins/hello/src/plugin.ts", 'export function hello(name: string): string {\n  return `Hello ${name}`;\n}\n');
  write(root, "plugins/hello/src/notes/readme.txt", "notes\n");
  write(root, "plugins/hello/README.md", "Not published.\n");
  write(root, "plugins/soon/plugin.json", {
    id: "soon",
    version: "0.1.0",
    apiVersion: 1,
    displayName: "Soon",
    description: "Not yet.",
    entrypoint: "src/plugin.mjs",
    capabilities: { projectDataShape: {} },
  });
  write(root, "plugins/soon/package.json", {
    name: "soon",
    version: "0.1.0",
    type: "module",
    ajour: { ...listing, name: "Soon to come", status: "coming-soon", website: undefined },
  });
  write(root, "plugins/soon/src/plugin.mjs", "export const soon = true;\n");
  commitAll(root, "first");
  return root;
}

function commitAll(root, message) {
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "--message", message);
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
}

async function makeKey() {
  const out = join(freshDirectory("keys"), "signing-key.json");
  const result = await keygen({ out, env, prompt: noPrompt, log: quiet });
  return { ...result, out };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A valid source entry to break in format tests. */
function validSource() {
  return {
    schemaVersion: 1,
    name: "Test plugins",
    plugins: [
      {
        id: "hello",
        name: "Hello",
        description: "Says hello.",
        version: "1.0.0",
        pluginApiVersion: 3,
        capabilities: ["connector"],
        features: ["greeting"],
        tags: ["hello"],
        author: { name: "Test Author", url: "https://example.com" },
        license: { name: "MIT License", spdxId: "MIT" },
        status: "available",
        commit: "a".repeat(40),
        path: "plugins/hello",
        files: [{ path: "plugin.json", sha256: "b".repeat(64), size: 10 }],
      },
    ],
  };
}

describe("fingerprints and signatures", () => {
  test("a fingerprint is the first 16 hex characters of SHA-256, in groups of four", () => {
    const raw = Buffer.alloc(32);
    assert.equal(fingerprint(raw), "6668 7aad f862 bd77");
    const { privateKey } = generateKeyPairSync("ed25519");
    assert.match(fingerprint(rawPublicKey(privateKey)), /^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
  });

  test("a raw public key round-trips through the SPKI prefix the format names", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const raw = rawPublicKey(publicKey);
    assert.equal(raw.length, 32);
    assert.ok(rawPublicKey(publicKeyFromRaw(raw)).equals(raw));
  });

  test("a signature covers the exact bytes, so one changed byte fails it", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const bytes = Buffer.from('{"schemaVersion":1}\n');
    const signature = signSource(bytes, privateKey);
    assert.deepEqual(Object.keys(signature), ["schemaVersion", "algorithm", "publicKey", "signature"]);
    assert.deepEqual(validateSignatureFile(signature), []);
    assert.ok(verifySourceSignature(bytes, signature).equals(rawPublicKey(privateKey)));
    assert.throws(() => verifySourceSignature(Buffer.from('{"schemaVersion":1} \n'), signature), /does not verify/);
    assert.throws(() => verifySourceSignature(Buffer.from('{"schemaVersion":1}\r\n'), signature), /does not verify/);
  });

  test("a signature file with an unknown key or a short key is refused", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const signature = signSource(Buffer.from("x"), privateKey);
    assert.match(validateSignatureFile({ ...signature, comment: "hi" }).join("\n"), /unknown key "comment"/);
    assert.match(validateSignatureFile({ ...signature, publicKey: "AAAA" }).join("\n"), /publicKey/);
  });

  test("a key file decrypts with its passphrase and refuses a wrong one", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const fast = { N: 1024, r: 8, p: 1 };
    const keyFile = encryptSigningKey(privateKey, passphrase, fast);
    assert.ok(rawPublicKey(decryptSigningKey(keyFile, passphrase)).equals(rawPublicKey(privateKey)));
    assert.throws(() => decryptSigningKey(keyFile, "wrong"), /passphrase is wrong/);
    assert.throws(() => decryptSigningKey({ ...keyFile, extra: 1 }, passphrase), /unknown key "extra"/);
  });
});

describe("keygen", () => {
  test("writes the key file in the format's shape and refuses to overwrite it", async () => {
    const { out, publicKey, fingerprint: print } = await makeKey();
    const keyFile = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(Object.keys(keyFile), ["schemaVersion", "algorithm", "publicKey", "kdf", "cipher", "encryptedPrivateKey"]);
    assert.deepEqual(
      { name: keyFile.kdf.name, N: keyFile.kdf.N, r: keyFile.kdf.r, p: keyFile.kdf.p },
      { name: "scrypt", N: 131072, r: 8, p: 1 },
    );
    assert.equal(Buffer.from(keyFile.kdf.salt, "base64").length, 16);
    assert.equal(keyFile.cipher.name, "aes-256-gcm");
    assert.equal(Buffer.from(keyFile.cipher.iv, "base64").length, 12);
    assert.equal(Buffer.from(keyFile.cipher.tag, "base64").length, 16);
    assert.equal(keyFile.publicKey, publicKey);
    assert.equal(print, fingerprint(Buffer.from(publicKey, "base64")));
    if (process.platform !== "win32") assert.equal(statSync(out).mode & 0o777, 0o600);
    await assert.rejects(keygen({ out, env, prompt: noPrompt, log: quiet }), /already exists/);
  });

  test("refuses to write the key inside the repository", async () => {
    const root = makeRepository();
    await assert.rejects(
      keygen({ out: join(root, "key.json"), cwd: root, env, prompt: noPrompt, log: quiet }),
      /inside the repository/,
    );
  });

  test("asks for the passphrase twice and refuses a mismatch", async () => {
    const out = join(freshDirectory("keys"), "signing-key.json");
    const answers = ["one passphrase", "another passphrase"];
    await assert.rejects(
      keygen({ out, env: {}, prompt: async () => answers.shift(), log: quiet }),
      /do not match/,
    );
    assert.equal(existsSync(out), false);
  });
});

describe("release and verify", () => {
  test("keygen, release and verify round-trip", async () => {
    const root = makeRepository();
    const key = await makeKey();
    const head = git(root, "rev-parse", "HEAD");
    const { source } = await release({ cwd: root, keyFile: key.out, env, prompt: noPrompt, log: quiet });

    const bytes = readFileSync(join(root, "ajour.json"));
    assert.equal(bytes.toString("utf8"), `${JSON.stringify(source, null, 2)}\n`);
    assert.deepEqual(validateSource(source), []);
    assert.equal(source.name, "Test plugins");
    const [hello, soon] = source.plugins;
    assert.deepEqual(Object.keys(hello), [
      "id", "name", "description", "version", "pluginApiVersion", "capabilities", "features", "tags",
      "author", "license", "website", "status", "commit", "path", "files",
    ]);
    assert.equal(hello.commit, head);
    assert.equal(hello.path, "plugins/hello");
    assert.deepEqual(hello.capabilities, ["connector"]);
    assert.deepEqual(hello.files.map((file) => file.path), [
      "package.json", "plugin.json", "src/notes/readme.txt", "src/plugin.ts",
    ]);
    const manifestBytes = readFileSync(join(root, "plugins/hello/plugin.json"));
    assert.deepEqual(hello.files[1], { path: "plugin.json", sha256: sha256(manifestBytes), size: manifestBytes.length });
    assert.deepEqual(soon, {
      id: "soon", name: "Soon to come", description: "Not yet.", version: "0.1.0", pluginApiVersion: 1,
      capabilities: ["schema"], features: listing.features, tags: listing.tags, author: listing.author,
      license: listing.license, status: "coming-soon",
    });

    const signature = JSON.parse(readFileSync(join(root, "ajour.json.sig"), "utf8"));
    assert.equal(signature.publicKey, key.publicKey);
    assert.equal(verifyRepository({ cwd: root, publicKey: key.publicKey, log: quiet }), true);

    const other = rawPublicKey(generateKeyPairSync("ed25519").publicKey).toString("base64");
    assert.throws(() => verifyRepository({ cwd: root, publicKey: other, log: quiet }), /signed by key/);

    // Committed, ajour.json names its parent, which stays in the history.
    commitAll(root, "release");
    assert.equal(verifyRepository({ cwd: root, publicKey: key.publicKey, log: quiet }), true);
  });

  test("a wrong passphrase writes nothing", async () => {
    const root = makeRepository();
    const key = await makeKey();
    await assert.rejects(
      release({ cwd: root, keyFile: key.out, env: { [PASSPHRASE_VARIABLE]: "wrong" }, prompt: noPrompt, log: quiet }),
      /passphrase is wrong/,
    );
    assert.equal(existsSync(join(root, "ajour.json")), false);
    assert.equal(existsSync(join(root, "ajour.json.sig")), false);
  });

  test("a tampered ajour.json fails its signature", async () => {
    const root = makeRepository();
    const key = await makeKey();
    await release({ cwd: root, keyFile: key.out, env, prompt: noPrompt, log: quiet });
    const path = join(root, "ajour.json");
    writeFileSync(path, readFileSync(path, "utf8").replace('"Hello"', '"Hello!"'));
    assert.throws(() => verifyRepository({ cwd: root, log: quiet }), /does not verify/);
    writeFileSync(path, readFileSync(path, "utf8").replace('"Hello!"', '"Hello"').replace(/\n/g, "\r\n"));
    assert.throws(() => verifyRepository({ cwd: root, log: quiet }), /CRLF/);
  });

  test("a changed plugin must bump its version before a release", async () => {
    const root = makeRepository();
    await release({ cwd: root, unsigned: true, log: quiet });
    commitAll(root, "release");

    write(root, "plugins/hello/src/plugin.ts", "export function hello(): string {\n  return 'Hi';\n}\n");
    commitAll(root, "change hello");
    await assert.rejects(release({ cwd: root, unsigned: true, log: quiet }), /plugins\/hello \(hello 1\.0\.0\).*Bump the version/s);

    writeHello(root, "1.0.1");
    commitAll(root, "bump hello");
    const { source } = await release({ cwd: root, unsigned: true, log: quiet });
    assert.equal(source.plugins[0].version, "1.0.1");
    assert.equal(verifyRepository({ cwd: root, log: quiet }), true);
  });

  test("an unchanged plugin keeps its version across releases", async () => {
    const root = makeRepository();
    await release({ cwd: root, unsigned: true, log: quiet });
    commitAll(root, "release");
    write(root, "plugins/hello/README.md", "Still not published.\n");
    commitAll(root, "docs");
    const { source } = await release({ cwd: root, unsigned: true, log: quiet });
    assert.equal(source.plugins[0].version, "1.0.0");
  });

  test("an unsigned release removes a stale signature", async () => {
    const root = makeRepository();
    const key = await makeKey();
    await release({ cwd: root, keyFile: key.out, env, prompt: noPrompt, log: quiet });
    commitAll(root, "signed release");
    const lines = [];
    await release({ cwd: root, unsigned: true, log: (line) => lines.push(line) });
    assert.equal(existsSync(join(root, "ajour.json.sig")), false);
    assert.match(lines.join("\n"), /git add ajour\.json ajour\.json\.sig && git commit && git push/);
    assert.equal(verifyRepository({ cwd: root, log: quiet }), true);
    assert.throws(() => verifyRepository({ cwd: root, publicKey: key.publicKey, log: quiet }), /unsigned/);
  });

  test("refuses a dirty working tree", async () => {
    const root = makeRepository();
    write(root, "plugins/hello/src/new.ts", "export {};\n");
    await assert.rejects(release({ cwd: root, unsigned: true, log: quiet }), /plugins\/hello\/src\/new\.ts/);
  });

  test("refuses a HEAD that is on no remote branch", async () => {
    const root = makeRepository();
    write(root, "plugins/hello/src/new.ts", "export {};\n");
    git(root, "add", "--all");
    git(root, "commit", "--quiet", "--message", "not pushed");
    await assert.rejects(release({ cwd: root, unsigned: true, log: quiet }), /on no remote branch/);
  });

  test("refuses TypeScript without a published package.json of type module", async () => {
    const root = makeRepository();
    write(root, "plugins/hello/package.json", { name: "hello", version: "1.0.0", ajour: listing });
    commitAll(root, "no type");
    await assert.rejects(release({ cwd: root, unsigned: true, log: quiet }), /"type": "module"/);

    write(root, "plugins/hello/package.json", {
      name: "hello", version: "1.0.0", type: "module", ajour: { ...listing, files: ["plugin.json", "src"] },
    });
    commitAll(root, "package.json not published");
    await assert.rejects(release({ cwd: root, unsigned: true, log: quiet }), /Add "package.json" to "ajour.files"/);
  });

  test("verify checks each file at its commit", async () => {
    const root = makeRepository();
    const { source } = await release({ cwd: root, unsigned: true, log: quiet });
    const broken = structuredClone(source);
    broken.plugins[0].files[3].sha256 = "0".repeat(64);
    broken.plugins[0].files[2].size += 1;
    broken.plugins[0].version = "9.9.9";
    writeFileSync(join(root, "ajour.json"), `${JSON.stringify(broken, null, 2)}\n`);
    assert.throws(() => verifyRepository({ cwd: root, log: quiet }), (error) => {
      assert.ok(error instanceof SourceError);
      assert.match(error.message, /src\/plugin\.ts at [0-9a-f]{7} does not match its sha256/);
      assert.match(error.message, /src\/notes\/readme\.txt at [0-9a-f]{7} is 6 bytes, but ajour\.json says 7/);
      assert.match(error.message, /plugin\.json at [0-9a-f]{7} has version "1\.0\.0"/);
      return true;
    });
  });

  test("verify with no ajour.json says so and exits 0", () => {
    const root = makeRepository();
    const result = spawnSync(process.execPath, [script, "verify"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no ajour\.json/);
  });

  test("the CLI prints a refusal without a stack and exits 1", () => {
    const root = makeRepository();
    write(root, "dirty.txt", "x\n");
    const result = spawnSync(process.execPath, [script, "release", "--unsigned"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^Commit or stash your changes first/);
    assert.doesNotMatch(result.stderr, /at .*ajour-source\.mjs/);
  });
});

describe("the source format", () => {
  test("accepts a valid source", () => {
    assert.deepEqual(validateSource(validSource()), []);
  });

  test("refuses unknown keys at every level", () => {
    const source = validSource();
    source.extra = true;
    source.plugins[0].homepage = "https://example.com";
    source.plugins[0].author.email = "a@example.com";
    source.plugins[0].files[0].mode = 420;
    const errors = validateSource(source).join("\n");
    assert.match(errors, /ajour\.json has an unknown key "extra"/);
    assert.match(errors, /\(hello\) has an unknown key "homepage"/);
    assert.match(errors, /author has an unknown key "email"/);
    assert.match(errors, /files\[0\] has an unknown key "mode"/);
  });

  test("refuses path traversal and other unsafe paths", () => {
    for (const path of ["../plugin.json", "src/../../x", "/etc/passwd", "src//x", "src/", "./x", "src\\x", "C:/x", "a b", ""]) {
      assert.ok(relativePathProblem(path), `${JSON.stringify(path)} should be refused`);
      const source = validSource();
      source.plugins[0].files.push({ path, sha256: "c".repeat(64), size: 1 });
      assert.match(validateSource(source).join("\n"), /files\[1\]\.path/, path);
    }
    for (const path of ["..", "plugins/../x", "/plugins"]) {
      const source = validSource();
      source.plugins[0].path = path;
      assert.match(validateSource(source).join("\n"), /\(hello\) path/, path);
    }
    assert.equal(relativePathProblem("src/vendor/ical.js.LICENSE"), undefined);
    assert.equal(relativePathProblem(`${"a/".repeat(99)}b`), undefined);
    assert.ok(relativePathProblem(`${"a/".repeat(100)}b`));
  });

  test("applies the status, files and limits rules", () => {
    const comingSoon = validSource();
    comingSoon.plugins[0].status = "coming-soon";
    assert.match(validateSource(comingSoon).join("\n"), /coming soon, so it must not list files/);

    const noFiles = validSource();
    delete noFiles.plugins[0].files;
    assert.match(validateSource(noFiles).join("\n"), /available, so it must list its files/);

    const noManifest = validSource();
    noManifest.plugins[0].files[0].path = "src/plugin.ts";
    assert.match(validateSource(noManifest).join("\n"), /must include plugin\.json/);

    const noCommit = validSource();
    delete noCommit.plugins[0].commit;
    assert.match(validateSource(noCommit).join("\n"), /must name their commit/);

    const bad = validSource();
    Object.assign(bad.plugins[0], {
      id: "x",
      version: "1.0",
      capabilities: ["connector", "connector", "printer"],
      tags: ["Not A Slug"],
      website: "http://example.com",
      author: { name: "Test Author", url: `https://example.com/${"a".repeat(500)}` },
      commit: "ABC",
      images: { thumbnail: { path: "assets/thumb.gif", sha256: "d".repeat(64), size: 2_000_000 } },
    });
    const errors = validateSource(bad).join("\n");
    for (const expected of [/ id must match/, /version must be a semantic version/, /lists "connector" twice/, /must be one of connector/, /tags\[0\]/, /website must be an HTTPS URL/, /author\.url must be at most 500 characters/,/commit must be a full commit id/, /thumbnail\.path must end in/, /thumbnail must be at most 1000000 bytes/]) {
      assert.match(errors, expected);
    }

    const twice = validSource();
    twice.plugins.push(structuredClone(twice.plugins[0]));
    assert.match(validateSource(twice).join("\n"), /id "hello" is listed twice/);
  });
});

describe("package", () => {
  test("writes a .ajour-connector archive that tar reads", () => {
    const root = makeRepository();
    write(root, "plugins/hello/src/draft.ts", "export const draft = 1;\n");
    write(root, "plugins/hello/.gitignore", "src/ignored.ts\n");
    write(root, "plugins/hello/src/ignored.ts", "export {};\n");
    const output = packagePlugin({ cwd: root, folder: "hello", log: quiet });
    assert.equal(output, join(root, "plugins", "hello", "package", "hello-1.0.0.ajour-connector"));

    const list = spawnSync("tar", ["-tzf", "hello-1.0.0.ajour-connector"], { cwd: dirname(output), encoding: "utf8" });
    assert.equal(list.status, 0, list.stderr);
    assert.deepEqual(list.stdout.split(/\r?\n/).filter(Boolean), [
      "package.json", "plugin.json", "src/", "src/draft.ts", "src/notes/", "src/notes/readme.txt", "src/plugin.ts",
    ]);
    const manifest = spawnSync("tar", ["-xzOf", "hello-1.0.0.ajour-connector", "plugin.json"], { cwd: dirname(output) });
    assert.equal(manifest.status, 0, String(manifest.stderr));
    assert.ok(manifest.stdout.equals(readFileSync(join(root, "plugins/hello/plugin.json"))));
  });

  test("writes long paths with the ustar prefix", () => {
    const long = `${"folder-name/".repeat(12)}file.txt`;
    assert.ok(long.length > 100);
    const directory = freshDirectory("tar");
    writeFileSync(join(directory, "long.tgz"), createConnectorArchive([{ path: long, data: Buffer.from("deep\n") }]));
    const list = spawnSync("tar", ["-tzf", "long.tgz"], { cwd: directory, encoding: "utf8" });
    assert.equal(list.status, 0, list.stderr);
    assert.ok(list.stdout.split(/\r?\n/).includes(long));
  });

  test("writes valid ustar headers", () => {
    const tar = createTar([{ path: "a.txt", data: Buffer.from("hi") }]);
    assert.equal(tar.length, 512 * 2 + 1024);
    assert.equal(tar.subarray(257, 263).toString("ascii"), "ustar\0");
    const header = Buffer.from(tar.subarray(0, 512));
    const stored = Number.parseInt(header.subarray(148, 154).toString("ascii"), 8);
    header.fill(0x20, 148, 156);
    assert.equal(stored, header.reduce((sum, byte) => sum + byte, 0));
    assert.ok(gunzipSync(createConnectorArchive([{ path: "a.txt", data: Buffer.from("hi") }])).subarray(512, 514).equals(Buffer.from("hi")));
  });
});
