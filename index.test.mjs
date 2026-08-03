import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
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

  for (const toolName of toolNames) {
    const wrappedTool = extension.tools.get(toolName)?.definition;
    assert.ok(wrappedTool, `${toolName} tool should be registered`);

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
