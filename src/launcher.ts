#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runLintWorker } from "./upstream-worker.js";

const NATIVE_CONFIG_NAMES = new Set([
  "rslint.config.js",
  "rslint.config.mjs",
  "rslint.config.ts",
  "rslint.config.mts",
]);
const RSTACK_CONFIG_NAMES = [
  "rstack.config.js",
  "rstack.config.mjs",
  "rstack.config.ts",
  "rstack.config.mts",
] as const;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

interface CliOptions {
  workspace: string;
}

interface WorkerCliOptions {
  coreDir: string;
  configPath?: string;
}

export interface Resolution {
  mode: "native" | "bridged";
  workspace: string;
  coreDir: string;
  configPath?: string;
  rstackDir?: string;
}

function usage(): never {
  throw new Error("Usage: rslint-lsp --workspace <absolute directory>");
}

export function parseArgs(args: readonly string[]): CliOptions {
  let workspace: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--workspace") {
      workspace = args[++index];
    } else {
      usage();
    }
  }
  if (!workspace || !path.isAbsolute(workspace)) usage();
  return {
    workspace: path.resolve(workspace),
  };
}

function parseWorkerArgs(args: readonly string[]): WorkerCliOptions {
  if (args.length !== 3 && args.length !== 5) usage();
  if (args[0] !== "--worker" || args[1] !== "--core") usage();
  const coreDir = args[2];
  if (!coreDir || !path.isAbsolute(coreDir)) usage();
  if (args.length === 3) return { coreDir };
  if (args[3] !== "--config" || !args[4] || !path.isAbsolute(args[4])) usage();
  return { coreDir, configPath: args[4] };
}

function findPackageJson(
  packageName: string,
  fromDirectory: string,
): string | undefined {
  let directory = path.resolve(fromDirectory);
  for (;;) {
    const candidate = path.join(
      directory,
      "node_modules",
      ...packageName.split("/"),
      "package.json",
    );
    try {
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch {
      // Continue with the parent directory.
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function assertPackageDirectory(
  packageName: string,
  directory: string,
): string {
  const packageJsonPath = path.join(directory, "package.json");
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${packageJsonPath}`, { cause: error });
  }
  if (
    !value ||
    typeof value !== "object" ||
    (value as { name?: unknown }).name !== packageName
  ) {
    throw new Error(`${packageJsonPath} is not a valid ${packageName} package`);
  }
  return fs.realpathSync(directory);
}

function resolvePackageDirectory(
  packageName: string,
  fromDirectory: string,
): string {
  const packageJsonPath = findPackageJson(packageName, fromDirectory);
  if (!packageJsonPath) {
    throw new Error(
      `Could not resolve ${packageName} from ${fromDirectory}. Install it in the project and restart the Rslint language server.`,
    );
  }
  return path.dirname(packageJsonPath);
}

function containsNativeConfig(root: string): boolean {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && NATIVE_CONFIG_NAMES.has(entry.name)) return true;
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) {
        pending.push(path.join(directory, entry.name));
      }
    }
  }
  return false;
}

function rootRstackConfig(root: string): string | undefined {
  for (const name of RSTACK_CONFIG_NAMES) {
    const candidate = path.join(root, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next supported extension.
    }
  }
  return undefined;
}

export function resolveWorkspace(options: {
  workspace: string;
  coreDir?: string;
}): Resolution {
  const workspace = fs.realpathSync(options.workspace);
  const native = containsNativeConfig(workspace);
  const rstackConfig = rootRstackConfig(workspace);

  if (!native && rstackConfig) {
    const rstackDir = resolvePackageDirectory("rstack", workspace);
    const coreDir = options.coreDir
      ? assertPackageDirectory("@rslint/core", options.coreDir)
      : resolvePackageDirectory("@rslint/core", rstackDir);
    const configPath = path.join(rstackDir, "dist", "rslintConfig.js");
    if (!fs.existsSync(configPath)) {
      throw new Error(
        `The installed rstack package does not provide ${configPath}. Upgrade rstack and restart the Rslint language server.`,
      );
    }
    return { mode: "bridged", workspace, coreDir, configPath, rstackDir };
  }

  const coreDir = options.coreDir
    ? assertPackageDirectory("@rslint/core", options.coreDir)
    : resolvePackageDirectory("@rslint/core", workspace);
  return { mode: "native", workspace, coreDir };
}

const INITIAL_REFRESH_ID = "rslint-zed-initial-config";
const CONFIG_DEPENDENCY_STATUS_NOTIFICATION = "rstack/rslintConfigDependency";

function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
    body,
  ]);
}

function createMessageReader(
  onMessage: (message: Record<string, unknown>, frame: Buffer) => void,
): (chunk: Buffer) => void {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      const separator = buffered.indexOf("\r\n\r\n");
      if (separator < 0) return;
      const header = buffered.subarray(0, separator).toString();
      const match = /(?:^|\r\n)Content-Length: (\d+)(?:\r\n|$)/i.exec(header);
      if (!match) throw new Error(`Invalid LSP header: ${header}`);
      const end = separator + 4 + Number(match[1]);
      if (buffered.length < end) return;
      const frame = buffered.subarray(0, end);
      const message = JSON.parse(
        buffered.subarray(separator + 4, end).toString(),
      ) as Record<string, unknown>;
      buffered = buffered.subarray(end);
      onMessage(message, frame);
    }
  };
}

async function runAdapter(resolution: Resolution): Promise<number> {
  const args = [
    fileURLToPath(import.meta.url),
    "--worker",
    "--core",
    resolution.coreDir,
    ...(resolution.configPath ? ["--config", resolution.configPath] : []),
  ];
  const child = spawn(process.execPath, args, {
    cwd: resolution.workspace,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.pipe(process.stderr, { end: false });

  let refreshInjected = false;
  const readEditor = createMessageReader((message, frame) => {
    child.stdin.write(frame);
    if (message.method === "initialized" && !refreshInjected) {
      refreshInjected = true;
      child.stdin.write(
        encodeMessage({
          jsonrpc: "2.0",
          id: INITIAL_REFRESH_ID,
          method: "rslint/configRefresh",
          params: { reason: "initial" },
        }),
      );
    }
  });
  const readServer = createMessageReader((message, frame) => {
    if (message.id === INITIAL_REFRESH_ID) {
      if (message.error) {
        process.stderr.write(
          `[rslint-zed] initial config refresh failed: ${JSON.stringify(message.error)}\n`,
        );
      }
      return;
    }
    if (message.method === CONFIG_DEPENDENCY_STATUS_NOTIFICATION) {
      return;
    }
    process.stdout.write(frame);
  });
  process.stdin.on("data", readEditor);
  child.stdout.on("data", readServer);
  process.stdin.on("end", () => child.stdin.end());

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => child.kill(signal));
  }
  return await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        process.stderr.write(`[rslint-zed] worker stopped by ${signal}\n`);
      }
      resolve(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  if (process.argv[2] === "--worker") {
    process.exitCode = await runLintWorker(
      parseWorkerArgs(process.argv.slice(2)),
    );
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const resolution = resolveWorkspace(options);
  process.exitCode = await runAdapter(resolution);
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(process.argv[1]) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return (
      path.basename(process.argv[1]) ===
      path.basename(fileURLToPath(import.meta.url))
    );
  }
}

if (isEntrypoint()) {
  void main().catch((error: unknown) => {
    const detail =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`[rslint-zed] ${detail}\n`);
    process.exitCode = 1;
  });
}
