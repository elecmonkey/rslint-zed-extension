import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "rstack/test";
import { resolveWorkspace } from "../src/launcher.ts";

function packageAt(directory: string, name: string): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify({ name, version: "1.0.0" })}\n`,
  );
}

describe("workspace resolution", () => {
  test("uses a directly installed @rslint/core for native config", () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "rslint-zed-native-"),
    );
    fs.writeFileSync(
      path.join(workspace, "rslint.config.mjs"),
      "export default [];\n",
    );
    const core = path.join(workspace, "node_modules/@rslint/core");
    packageAt(core, "@rslint/core");

    const resolution = resolveWorkspace({ workspace });
    assert.equal(resolution.mode, "native");
    assert.equal(resolution.coreDir, fs.realpathSync(core));
    assert.equal(resolution.configPath, undefined);
  });

  test("resolves the core through rstack and uses its config shim", () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "rslint-zed-bridge-"),
    );
    fs.writeFileSync(
      path.join(workspace, "rstack.config.mjs"),
      "export default {};\n",
    );
    const rstack = path.join(workspace, "node_modules/rstack");
    const core = path.join(rstack, "node_modules/@rslint/core");
    packageAt(rstack, "rstack");
    packageAt(core, "@rslint/core");
    fs.mkdirSync(path.join(rstack, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(rstack, "dist/rslintConfig.js"),
      "export default [];\n",
    );

    const resolution = resolveWorkspace({ workspace });
    assert.equal(resolution.mode, "bridged");
    assert.equal(resolution.rstackDir, fs.realpathSync(rstack));
    assert.equal(resolution.coreDir, fs.realpathSync(core));
    assert.equal(
      resolution.configPath,
      path.join(fs.realpathSync(rstack), "dist/rslintConfig.js"),
    );
  });

  test("native config takes ownership when both config families exist", () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "rslint-zed-owner-"),
    );
    fs.mkdirSync(path.join(workspace, "packages/app"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "packages/app/rslint.config.ts"),
      "export default [];\n",
    );
    fs.writeFileSync(
      path.join(workspace, "rstack.config.ts"),
      "export default {};\n",
    );
    const core = path.join(workspace, "node_modules/@rslint/core");
    packageAt(core, "@rslint/core");

    const resolution = resolveWorkspace({ workspace });
    assert.equal(resolution.mode, "native");
    assert.equal(resolution.coreDir, fs.realpathSync(core));
  });
});
