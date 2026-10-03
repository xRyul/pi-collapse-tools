import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters as stripAnsi } from "node:util";

import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  createCodemodeExtension,
  initTheme,
  ExtensionRunner,
  discoverAndLoadExtensions,
} from "@earendil-works/pi-coding-agent";

const extensionDir = fileURLToPath(new URL(".", import.meta.url));
const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const toolFactories = {
  read: createReadToolDefinition,
  bash: createBashToolDefinition,
  edit: createEditToolDefinition,
  write: createWriteToolDefinition,
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
  ls: createLsToolDefinition,
};
const toolNames = Object.keys(toolFactories);

test("preserves complete built-in definitions while replacing their renderers", async (t) => {
  const discoveryRoot = await mkdtemp(join(tmpdir(), "pi-collapse-tools-"));
  t.after(() => rm(discoveryRoot, { recursive: true, force: true }));

  const originalArgv = process.argv;
  process.argv = [originalArgv[0], originalArgv[1], `--tools=${toolNames.join(",")}`];

  let result;
  try {
    result = await discoverAndLoadExtensions(
      [extensionPath],
      discoveryRoot,
      join(discoveryRoot, "agent"),
    );
  } finally {
    process.argv = originalArgv;
  }

  assert.deepEqual(result.errors, []);
  const resolvedExtensionPath = await realpath(extensionPath);
  const extension = result.extensions.find(
    (candidate) => candidate.resolvedPath === resolvedExtensionPath,
  );
  assert.ok(extension, "collapse-tools extension should be loaded");
  assert.deepEqual([...extension.tools.keys()], toolNames);
  const runner = new ExtensionRunner(result.extensions, result.runtime, extensionDir);

  for (const toolName of toolNames) {
    const wrappedTool = extension.tools.get(toolName)?.definition;
    assert.ok(wrappedTool, `${toolName} tool should be registered`);
    const routed = runner.resolveToolRenderers(toolName, () => wrappedTool);
    assert.equal(routed, wrappedTool, `${toolName} must keep its registered renderers`);
    const theme = { fg: (_color, text) => text, bold: (text) => text };
    const call = routed.renderCall({ command: "echo test", path: "test.txt", pattern: "test" }, theme);
    assert.ok(call.text.startsWith(toolName), `${toolName} call must keep its compact header`);

    const builtInTool = toolFactories[toolName](extensionDir);
    const missingKeys = Object.keys(builtInTool).filter(
      (key) => !Object.hasOwn(wrappedTool, key),
    );
    assert.deepEqual(missingKeys, [], `${toolName} should retain all definition fields`);
    assert.equal(wrappedTool.promptSnippet, builtInTool.promptSnippet);
    assert.deepEqual(wrappedTool.promptGuidelines, builtInTool.promptGuidelines);
    assert.equal(wrappedTool.renderShell, builtInTool.renderShell);
    assert.equal(typeof wrappedTool.renderCall, "function");
    assert.equal(typeof wrappedTool.renderResult, "function");
    const collapsedComponent = wrappedTool.renderResult(
      { content: [{ type: "text", text: "hidden" }], details: undefined },
      { expanded: false, isPartial: false },
      {},
      { state: {} },
    );
    assert.equal(collapsedComponent.text, "");
  }

  const wrappedEdit = extension.tools.get("edit")?.definition;
  const normalized = wrappedEdit?.prepareArguments?.({
    path: "example.txt",
    oldText: "before",
    newText: "after",
  });
  assert.deepEqual(normalized, {
    path: "example.txt",
    edits: [{ oldText: "before", newText: "after" }],
  });

  assert.ok(wrappedEdit?.renderResult, "edit result renderer should be registered");
  const editResult = { content: [{ type: "text", text: "" }], details: undefined };
  const renderContext = {
    args: {
      path: "example.txt",
      edits: [{ oldText: "before", newText: "after" }],
    },
    toolCallId: "edit-test",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: extensionDir,
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
  };
  const collapsedComponent = wrappedEdit.renderResult(
    editResult,
    { expanded: false, isPartial: false },
    {},
    renderContext,
  );
  assert.doesNotThrow(() =>
    wrappedEdit.renderResult(
      editResult,
      { expanded: true, isPartial: false },
      {},
      { ...renderContext, expanded: true, lastComponent: collapsedComponent },
    ),
  );
});

test("codemode keeps native tool metadata while hiding the script and output", async (t) => {
  const discoveryRoot = await mkdtemp(join(tmpdir(), "pi-collapse-codemode-"));
  t.after(() => rm(discoveryRoot, { recursive: true, force: true }));
  const originalArgv = process.argv;
  let loaded;
  try {
    process.argv = [originalArgv[0], originalArgv[1], "--no-tools"];
    loaded = await discoverAndLoadExtensions([extensionPath], discoveryRoot, join(discoveryRoot, "agent"));
  } finally {
    process.argv = originalArgv;
  }
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  assert.equal(extension.tools.size, 0, "rendering must not enable any tools");
  assert.equal(extension.toolRenderers?.length, 1, "codemode renderer should be registered");
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, extensionDir);
  const resolve = (name, base) => runner.resolveToolRenderers(name, base);
  const custom = { renderCall() {}, renderResult() {} };
  for (const name of ["hashline_edit", "mcp__example__search", "subagent"]) {
    assert.equal(resolve(name, () => custom), custom, `${name} renderer must remain unchanged`);
  }

  let original;
  createCodemodeExtension()({ registerTool: (tool) => { original = tool; } });
  const renderers = resolve("codemode", () => original);
  initTheme("dark", false);
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  const args = { code: 'await tools.bash({ command: "echo secret-argument" });' };
  const result = {
    content: [{ type: "text", text: "secret-output" }],
    details: { calls: [
      { id: "test/1", name: "bash", args: "secret-argument", status: "ok", durationMs: 123, cost: 0.002 },
      { id: "test/2", name: "read", args: "secret-path", status: "running" },
      { id: "test/3", name: "write", args: "secret-path", status: "error", error: "secret-error" },
      { id: "test/4", name: "grep", args: "secret-pattern", status: "cancelled", durationMs: 1432 },
    ] },
  };
  const context = {
    args, toolCallId: "test", state: {}, cwd: extensionDir, invalidate() {},
    executionStarted: true, argsComplete: true, expanded: false, isPartial: false,
    showImages: false, isError: false, lastComponent: undefined,
  };
  const plain = (component) => component.render(200).map((line) => stripAnsi(line).trim()).join("\n").trim();
  let lastResult;
  const nativeRows = plain(original.renderResult({ ...result, content: [] },
    { expanded: false, isPartial: false }, theme, { ...context, lastComponent: undefined }));

  // Repeat expansion to exercise built-in Container reuse after our collapsed Text.
  for (const expanded of [false, true, false, true]) {
    context.expanded = expanded;
    const call = renderers.renderCall(args, theme, context);
    const output = renderers.renderResult(result, { expanded, isPartial: false }, theme, {
      ...context, lastComponent: lastResult,
    });
    if (expanded) {
      assert.match(plain(call), /secret-argument/);
      assert.match(plain(output), /secret-output/);
      assert.match(plain(output), /secret-error/);
    } else {
      assert.equal(plain(call), "codemode");
      assert.equal(plain(output), nativeRows);
      assert.match(stripAnsi(output.render(200)[0]).trim(), /^✓ bash/,
        "collapsed tool rows must start immediately, without a blank line");
      assert.match(plain(output), /bash secret-argument 123ms/);
      assert.match(plain(output), /1\.4s/);
      assert.match(plain(output), /\$0\.0020/);
      assert.doesNotMatch(plain(output), /secret-output|secret-error/);
    }
    context.lastComponent = call;
    lastResult = output;
  }

  context.expanded = false;
  assert.equal(plain(renderers.renderResult(result, { expanded: false, isPartial: true }, theme, context)),
    nativeRows);
  assert.equal(plain(renderers.renderResult({ content: [], details: undefined },
    { expanded: false, isPartial: false }, theme, context)), "");
});
