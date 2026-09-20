import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { expect, test } from "rstack/test";

const repository = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const rstackPackageJson = require.resolve("rstack/package.json");
const rslintCore = path.dirname(
  createRequire(rstackPackageJson).resolve("@rslint/core/package.json"),
);

type LspMessage = {
  [key: string]: unknown;
  id?: number | string;
  method?: string;
  error?: unknown;
};

type Diagnostic = { source?: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function diagnosticsOf(message: LspMessage): Diagnostic[] | undefined {
  if (!isRecord(message.params) || !Array.isArray(message.params.diagnostics)) {
    return undefined;
  }
  return message.params.diagnostics as Diagnostic[];
}

async function runSmokeTest(
  kind: "native" | "bridged",
  launcher = path.join(repository, "dist/rslint-lsp.js"),
): Promise<void> {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), `rslint-zed-${kind}-`),
  );
  const packageLink = (name: string, source?: string): void => {
    source ??= path.join(repository, "node_modules", ...name.split("/"));
    const target = path.join(workspace, "node_modules", ...name.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(
      source,
      target,
      process.platform === "win32" ? "junction" : "dir",
    );
  };
  if (kind === "native") {
    packageLink("@rslint/core", rslintCore);
    fs.writeFileSync(
      path.join(workspace, "rslint.config.mjs"),
      "export default [{ rules: { 'no-unused-vars': 'error' } }];\n",
    );
  } else {
    packageLink("rstack");
    fs.writeFileSync(
      path.join(workspace, "rstack.config.mjs"),
      "import { define } from 'rstack'; define.lint([{ rules: { 'no-unused-vars': 'error' } }]);\n",
    );
  }

  const child = spawn(process.execPath, [launcher, "--workspace", workspace], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = Buffer.alloc(0);
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = Buffer.concat([stdout, chunk]);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  function send(message: Record<string, unknown>): void {
    const body = Buffer.from(JSON.stringify(message));
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  }

  async function messageMatching(
    predicate: (message: LspMessage) => boolean,
    timeoutMs = 15_000,
  ): Promise<LspMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const separator = stdout.indexOf("\r\n\r\n");
      if (separator >= 0) {
        const header = stdout.subarray(0, separator).toString();
        const match = /Content-Length: (\d+)/i.exec(header);
        if (!match) {
          throw new Error(`invalid LSP header: ${header}`);
        }
        const length = Number(match[1]);
        const end = separator + 4 + length;
        if (stdout.length >= end) {
          const message = JSON.parse(
            stdout.subarray(separator + 4, end).toString(),
          ) as LspMessage;
          stdout = stdout.subarray(end);
          if (message.id !== undefined && message.method) {
            send({ jsonrpc: "2.0", id: message.id, result: null });
          }
          if (predicate(message)) return message;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for an LSP message\n${stderr}`);
  }

  const response = (id: number): Promise<LspMessage> =>
    messageMatching((message) => message.id === id);

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: process.pid,
        rootUri: `file://${workspace}`,
        capabilities: {},
        workspaceFolders: [{ uri: `file://${workspace}`, name: "fixture" }],
      },
    });
    const initialized = await response(1);
    expect(initialized.error).toBeUndefined();
    expect(isRecord(initialized.result)).toBe(true);
    const result = initialized.result as Record<string, unknown>;
    expect(typeof result.capabilities).toBe("object");
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    const documentPath = path.join(workspace, "index.ts");
    const documentUri = `file://${documentPath}`;
    const source = "const unused = 1;\n";
    fs.writeFileSync(documentPath, source);
    send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: documentUri,
          languageId: "typescript",
          version: 1,
          text: source,
        },
      },
    });
    const diagnosticsMessage = await messageMatching((message) => {
      if (message.method !== "textDocument/publishDiagnostics") return false;
      if (!isRecord(message.params) || message.params.uri !== documentUri) {
        return false;
      }
      return (diagnosticsOf(message)?.length ?? 0) > 0;
    });
    const diagnostics = diagnosticsOf(diagnosticsMessage);
    expect(
      diagnostics?.some(
        (diagnostic) =>
          diagnostic.source === "rslint" &&
          diagnostic.message.includes("[no-unused-vars]"),
      ),
    ).toBe(true);
    send({ jsonrpc: "2.0", id: 2, method: "shutdown" });
    const shutdown = await response(2);
    expect(shutdown.error).toBeUndefined();
    send({ jsonrpc: "2.0", method: "exit" });
  } finally {
    child.stdin.end();
    setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
  }

  const exitCode = await new Promise<number | null>((resolve) =>
    child.once("close", resolve),
  );
  if (exitCode !== 0) {
    throw new Error(stderr);
  }
  expect(exitCode).toBe(0);
  console.log(
    `Rslint ${kind} LSP published diagnostics and shut down successfully.`,
  );
}

test("publishes diagnostics with a native Rslint config", async () => {
  await runSmokeTest("native");
});

test("publishes diagnostics with a Rstack config", async () => {
  await runSmokeTest("bridged");
});

test("publishes diagnostics when the launcher is invoked through a symlink", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rslint-zed-link-"));
  const launcher = path.join(workspace, "rslint-lsp.js");
  fs.symlinkSync(path.join(repository, "dist/rslint-lsp.js"), launcher);
  await runSmokeTest("bridged", launcher);
});
