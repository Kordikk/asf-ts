// Trusted host source inspection only. No native sessions, credentials, or rollback.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FILE = 1024 * 1024; // Allowed text copies only, not public asset hashing.
const MAX_TOTAL = 64 * MAX_FILE;
const MAX_PATCH = 16 * 1024; // Also enforce serialized output below Runtime's 24 KiB capture.
const decoder = new TextDecoder("utf-8", { fatal: true });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const encode = (value) => JSON.stringify(value);
function git(args, ok = [0]) {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      maxBuffer: 8 * MAX_FILE,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    if (ok.includes(e.status) && Buffer.isBuffer(e.stdout)) return e.stdout;
    throw new Error("Source git inspection failed or exceeded bounds");
  }
}
export function sourcePath(path) {
  if (
    typeof path !== "string" ||
    Buffer.byteLength(path) > 240 ||
    !/^[a-zA-Z0-9_./-]+$/.test(path) ||
    path.split("/").some((s) => !s || s.startsWith(".")) ||
    ["node_modules", "dist"].includes(path.split("/")[0])
  )
    throw new Error("Invalid source path");
  return path;
}
function bytes(path, max = MAX_FILE) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > max)
    throw new Error("Nonregular or oversized source/artifact");
  const data = readFileSync(path);
  if (data.length > max) throw new Error("Source grew beyond bound");
  return data;
}
function source(path, max) {
  // Refuse symlink ancestors as well as symlink files; never follow into native state.
  for (let p = dirname(path); p !== "."; p = dirname(p)) {
    try {
      if (!lstatSync(p).isDirectory())
        throw new Error("Unsafe source ancestor");
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > max)
      throw new Error("Nonregular or oversized source");
    // Hash larger public assets in bounded chunks; never copy them to artifacts.
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile()) throw new Error("Nonregular source");
      const digest = createHash("sha256"),
        chunk = Buffer.alloc(64 * 1024);
      let size = 0,
        count;
      while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
        size += count;
        if (size > max) throw new Error("Source grew beyond bound");
        digest.update(chunk.subarray(0, count));
      }
      return { hash: digest.digest("hex"), mode: stat.mode & 0o777, size };
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
function inventory() {
  if (
    decoder.decode(git(["rev-parse", "--show-toplevel"])).trim() !==
    realpathSync(".")
  )
    throw new Error("cwd must be repository root");
  const names = decoder.decode(
    git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
  );
  if (names && !names.endsWith("\0")) throw new Error("Malformed source list");
  const paths = [...new Set(names.split("\0").filter(Boolean))].sort();
  if (paths.length > 5000) throw new Error("Too many source paths");
  let total = 0;
  const files = Object.fromEntries(
    paths.map((path) => {
      // Fail before reading known native/private paths if mistakenly nonignored.
      if (
        [
          ".git",
          ".asf",
          ".codex",
          ".opencode",
          ".pi",
          ".ssh",
          ".env",
          ".npmrc",
          ".netrc",
        ].includes(path.split("/")[0]) ||
        path.startsWith(".env.") ||
        path.includes("..") ||
        path.startsWith("/")
      )
        throw new Error("Unsafe inventory path");
      const state = source(path, MAX_TOTAL - total);
      total += state?.size ?? 0;
      if (total > MAX_TOTAL) throw new Error("Source snapshot too large");
      return [path, state];
    }),
  );
  return {
    files,
    head: decoder.decode(git(["rev-parse", "HEAD"])).trim(),
    branch: decoder.decode(git(["symbolic-ref", "-q", "HEAD"], [0, 1])).trim(),
    // Semantic index content/modes and assume-unchanged/skip-worktree flags;
    // not transient filesystem stat-cache refreshes by ordinary git diff.
    index: hash(
      Buffer.concat([
        git(["ls-files", "--stage", "-z"]),
        git(["ls-files", "-v", "-z"]),
      ]),
    ),
  };
}
function artifactPath(path) {
  if (!/^\.asf\/self-improvement\/[a-zA-Z0-9_-]{1,100}$/.test(path))
    throw new Error("Invalid artifact directory");
  // No inherited artifact or .asf symlink, and artifacts must be ignored.
  for (const part of [".asf", ".asf/self-improvement", path]) {
    try {
      if (!lstatSync(part).isDirectory())
        throw new Error("Unsafe artifact directory");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  if (!git(["check-ignore", "--", `${path}/manifest.json`], [0, 1]).length)
    throw new Error("Artifact directory must be gitignored");
  return path;
}
export function capture(artifact, allowed) {
  artifactPath(artifact);
  if (
    !Array.isArray(allowed) ||
    !allowed.length ||
    allowed.length > 20 ||
    new Set(allowed).size !== allowed.length
  )
    throw new Error("Require 1..20 distinct edit files");
  allowed.forEach(sourcePath);
  for (const path of allowed) {
    if (git(["check-ignore", "--", path], [0, 1]).length)
      throw new Error("Allowed source cannot be ignored");
  }
  const baseline = inventory();
  mkdirSync(artifact, { recursive: false, mode: 0o700 });
  const manifest = { version: 1, allowed, baseline };
  allowed.forEach((path, i) => {
    const data = baseline.files[path] ? bytes(path) : Buffer.alloc(0);
    decoder.decode(data); // Reject binary/malformed allowed source rather than fake a patch.
    if (data.includes(0)) throw new Error("Binary allowed source");
    writeFileSync(`${artifact}/${i}.before`, data, { flag: "wx", mode: 0o600 });
    if (baseline.files[path] && hash(data) !== baseline.files[path].hash)
      throw new Error("Source changed during capture");
  });
  const data = encode(manifest);
  writeFileSync(`${artifact}/manifest.json`, data, { flag: "wx", mode: 0o600 });
  if (encode(inventory()) !== encode(baseline))
    throw new Error("Source changed during capture");
  return {
    artifact,
    hash: hash(data),
    state: hash(encode(baseline)),
    files: Object.keys(baseline.files).length,
  };
}
export function inspect(artifact, digest) {
  artifactPath(artifact);
  const raw = bytes(`${artifact}/manifest.json`, 8 * MAX_FILE);
  if (hash(raw) !== digest) throw new Error("Baseline artifact changed");
  const { version, allowed, baseline } = JSON.parse(decoder.decode(raw));
  if (version !== 1 || !Array.isArray(allowed))
    throw new Error("Malformed baseline");
  const current = inventory();
  if (
    current.head !== baseline.head ||
    current.branch !== baseline.branch ||
    current.index !== baseline.index
  )
    throw new Error("Scope violation: HEAD/branch/index changed");
  const paths = new Set([
    ...Object.keys(baseline.files),
    ...Object.keys(current.files),
  ]);
  for (const path of paths) {
    const before = baseline.files[path] ?? null,
      after = current.files[path] ?? null;
    if (encode(before) === encode(after)) continue;
    if (
      !allowed.includes(path) ||
      (before && (!after || after.mode !== before.mode))
    )
      throw new Error(`Scope violation: ${path}`);
  }
  let patch = "";
  allowed.forEach((path, i) => {
    sourcePath(path);
    const before = bytes(`${artifact}/${i}.before`);
    if (hash(before) !== (baseline.files[path]?.hash ?? hash(Buffer.alloc(0))))
      throw new Error("Baseline copy changed");
    if (!current.files[path]) return;
    const after = bytes(path);
    decoder.decode(after);
    if (after.includes(0) || hash(after) !== current.files[path].hash)
      throw new Error("Malformed or changing patch source");
    if (hash(after) === hash(before)) {
      if (!baseline.files[path]) patch += `Added empty source: ${path}\n`;
      return;
    }
    let diff = decoder.decode(
      git(
        [
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-textconv",
          "--",
          `${artifact}/${i}.before`,
          path,
        ],
        [0, 1],
      ),
    );
    diff = diff.replaceAll(`a/${artifact}/${i}.before`, `a/${path}`);
    patch += `${baseline.files[path] ? "Modified" : "Added"}: ${path}\n${diff}`;
    if (Buffer.byteLength(patch) > MAX_PATCH)
      throw new Error("Patch exceeds review bound");
  });
  if (encode(inventory()) !== encode(current))
    throw new Error("Source changed during inspection");
  return {
    state: hash(encode(current)),
    patch,
    files: Object.keys(current.files).length,
    editFiles: allowed,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [mode, artifact, arg] = process.argv.slice(2);
    if (!artifact || !arg || !["capture", "inspect"].includes(mode))
      throw new Error("Invalid helper arguments");
    if (mode === "capture") {
      artifactPath(artifact);
      mkdirSync(".asf/self-improvement", { recursive: true, mode: 0o700 });
    }
    const result =
      mode === "capture"
        ? capture(artifact, JSON.parse(arg))
        : inspect(artifact, arg);
    const output = encode(result);
    if (Buffer.byteLength(output) > 22 * 1024)
      throw new Error("Helper output exceeds capture bound");
    console.log(output);
  } catch (e) {
    console.error(String(e.message).slice(0, 2000));
    process.exitCode = 1;
  }
}
