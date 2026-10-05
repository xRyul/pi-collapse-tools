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
  ToolExecutionComponent,
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
      assert.equal(plain(output), `${nativeRows}\nTokens ~4`);
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
    { expanded: false, isPartial: false }, theme, context)), "Tokens ~0");

  const tokenHook = extension.handlers.get("tool_result")?.[0];
  assert.equal(typeof tokenHook, "function", "record context capacity on codemode results");
  const event = {
    type: "tool_result", toolName: "codemode", toolCallId: "tokens", input: args,
    ...result, isError: false,
  };
  const hookContext = {
    getContextUsage: () => ({ contextWindow: 272_000 }),
    model: { contextWindow: 200_000 },
  };
  const update = await tokenHook(event, hookContext);
  assert.equal(update.details.collapseToolsContextWindow, 272_000);
  assert.deepEqual(update.details.calls, result.details.calls);
  assert.equal(Object.hasOwn(update, "content"), false, "UI metadata must not replace model-facing output");
  assert.equal(Object.hasOwn(result.details, "collapseToolsContextWindow"), false);
  const fallback = await tokenHook(event, { ...hookContext, getContextUsage: () => undefined });
  assert.equal(fallback.details.collapseToolsContextWindow, 200_000);
  assert.equal(await tokenHook({ ...event, toolName: "bash" }, hookContext), undefined);
  const structuredContent = { output: "original-data" };
  const pipelineResult = await runner.emitToolResult({ ...event, structuredContent });
  assert.equal(pipelineResult.content, event.content, "the real hook pipeline must preserve content");
  assert.equal(pipelineResult.structuredContent, structuredContent);
  assert.deepEqual(pipelineResult.details.calls, event.details.calls);
  assert.equal(await runner.emitToolResult({ ...event, toolName: "bash" }), undefined);

  const tokenOutput = (output, isPartial = false) => plain(renderers.renderResult(
    output, { expanded: false, isPartial }, theme, { ...context, state: {}, lastComponent: undefined },
  ));
  const filtered = {
    ...result,
    content: [{ type: "text", text: "x".repeat(272) }],
    details: JSON.parse(JSON.stringify(update.details)),
  };
  assert.equal(tokenOutput(filtered), `${nativeRows}\nTokens ~68 (0.025%)`,
    "estimate final returned content, with context metadata surviving session serialization");
  assert.doesNotMatch(tokenOutput(filtered, true), /Tokens/, "no token footer while running");
  assert.match(tokenOutput({ ...filtered, content: [{ type: "text", text: "x".repeat(400) }] }),
    /Tokens ~100 \(0\.037%\)$/, "estimate content after any later result transformation");
  assert.match(tokenOutput({ ...filtered, content: [{ type: "image", data: "", mimeType: "image/png" }] }),
    /Tokens ~1,200 \(0\.441%\)$/, "use Pi's image token estimate even when output is hidden");

  for (const [text, capacity, expected] of [
    ["x".repeat(4096), 200_000, "Tokens ~1,024 (0.512%)"],
    ["x", 1_000_000, "Tokens ~1 (<0.001%)"],
    ["", 272_000, "Tokens ~0 (0.000%)"],
    ...[undefined, 0, -1, NaN, Infinity].map((capacity) => ["x", capacity, "Tokens ~1"]),
  ]) {
    assert.equal(tokenOutput({
      content: [{ type: "text", text }],
      details: { calls: [], collapseToolsContextWindow: capacity },
    }), expected);
  }

  // Exercise Pi's real generation/execution lifecycle with a deterministic clock.
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  let redraws = 0;
  const ui = { requestRender() { redraws++; } };
  const makeExecution = async (id, live = true) => {
    if (live) {
      const message = { role: "assistant", content: [{ type: "toolCall", name: "codemode", id, arguments: args }] };
      await runner.emit({
        type: "message_update", message,
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: message },
      });
    }
    return new ToolExecutionComponent(
      "codemode", id, args, { showImages: false }, renderers, ui, extensionDir,
    );
  };

  // /tree rebuilds a historical call with isPartial=true when its result is beyond the selected leaf.
  const historical = await makeExecution("historical-codemode", false);
  assert.doesNotMatch(plain(historical), /•••/, "a history row without a result is not live work");
  const historyRedraws = redraws;
  t.mock.timers.tick(700);
  assert.equal(redraws, historyRedraws, "historical rows must not create animation timers");

  const execution = await makeExecution("busy-codemode");
  historical.setExpanded(true);
  historical.setExpanded(false);
  assert.doesNotMatch(plain(historical), /•••/, "old rows must remain idle while a new call is live");
  const generating = execution.render(200).join("\n");
  assert.match(stripAnsi(generating), /codemode •••/);
  assert.doesNotMatch(stripAnsi(generating), /secret-argument/);
  t.mock.timers.tick(350);
  assert.ok(redraws > 0, "the dots should request redraws while generating");
  assert.notEqual(execution.render(200).join("\n"), generating, "the highlighted dot should move");

  execution.setArgsComplete();
  execution.markExecutionStarted();
  execution.updateResult(result, true);
  assert.match(stripAnsi(execution.render(200).join("\n")), /codemode •••/);
  assert.match(stripAnsi(execution.render(200).join("\n")), /123ms/);
  execution.setExpanded(true);
  const expandedRedraws = redraws;
  t.mock.timers.tick(700);
  assert.equal(redraws, expandedRedraws, "pause the hidden animation when expanded");
  execution.setExpanded(false);
  await runner.emit({
    type: "tool_execution_end", toolName: "codemode", toolCallId: "busy-codemode", result, isError: false,
  });
  assert.doesNotMatch(plain(execution), /•••/, "execution-end must stop the dots before the final UI update");
  execution.updateResult(result, false);
  assert.doesNotMatch(stripAnsi(execution.render(200).join("\n")), /•••/);
  const completedRedraws = redraws;
  t.mock.timers.tick(700);
  assert.equal(redraws, completedRedraws, "completed calls must stop their animation");
  const completedHistory = await makeExecution("busy-codemode", false);
  assert.doesNotMatch(plain(completedHistory), /•••/, "rebuilding a completed call before its result must stay idle");

  const lastLine = (tool) => tool.render(200).map((line) => stripAnsi(line).trim()).filter(Boolean).at(-1);
  const timed = await makeExecution("result-timer");
  t.mock.timers.tick(1400);
  assert.doesNotMatch(lastLine(timed), /^\d+(?:\.\d+)?(?:ms|s)$/, "no timer during code generation");
  timed.setArgsComplete();
  timed.markExecutionStarted();
  timed.updateResult(result, true);
  t.mock.timers.tick(1050);
  assert.doesNotMatch(lastLine(timed), /^\d+(?:\.\d+)?(?:ms|s)$/, "no timer while a tool is still running");
  const finishedTools = {
    ...result,
    details: { calls: result.details.calls.map((call) => ({
      ...call, status: call.status === "running" ? "ok" : call.status,
    })) },
  };
  timed.updateResult(finishedTools, true);
  assert.equal(lastLine(timed), "0ms", "start timing only after the listed tools finish");
  t.mock.timers.tick(700);
  assert.equal(lastLine(timed), "700ms");
  assert.doesNotMatch(plain(timed), /Processing results/);
  timed.setExpanded(true);
  t.mock.timers.tick(700);
  timed.setExpanded(false);
  assert.equal(lastLine(timed), "1.4s", "expansion must not reset elapsed time");
  timed.updateResult(result, true);
  assert.doesNotMatch(lastLine(timed), /^\d+(?:\.\d+)?(?:ms|s)$/, "hide the timer if another tool starts");
  timed.updateResult(finishedTools, true);
  assert.equal(lastLine(timed), "0ms", "restart timing after the new tool finishes");
  t.mock.timers.tick(700);
  timed.updateResult(finishedTools, false);
  assert.equal(lastLine(timed), "700ms · Tokens ~4");
  const frozenRedraws = redraws;
  t.mock.timers.tick(1400);
  assert.equal(lastLine(timed), "700ms · Tokens ~4", "freeze the final time when codemode returns");
  assert.equal(redraws, frozenRedraws);

  for (const [elapsed, expected] of [[17, "17ms"], [999, "999ms"], [1000, "1.0s"]]) {
    const quick = await makeExecution(`duration-${elapsed}`);
    quick.setArgsComplete();
    quick.markExecutionStarted();
    quick.updateResult(finishedTools, true);
    t.mock.timers.tick(elapsed);
    quick.updateResult(finishedTools, false);
    assert.equal(lastLine(quick), `${expected} · Tokens ~4`, "match native tool duration formatting");
  }

  // Tool execution can begin without a streamed call (e.g. an SDK-issued call).
  const directId = "execution-without-stream";
  await runner.emit({ type: "tool_execution_start", toolName: "codemode", toolCallId: directId, args });
  const direct = await makeExecution(directId, false);
  assert.match(plain(direct), /•••/, "execution-start must animate genuinely live calls");
  await runner.emit({
    type: "tool_execution_end", toolName: "codemode", toolCallId: directId, result: finishedTools, isError: false,
  });
  assert.doesNotMatch(plain(direct), /•••/);
  const directRedraws = redraws;
  t.mock.timers.tick(700);
  assert.equal(redraws, directRedraws, "execution-end must dispose the animation timer");

  const interrupted = await makeExecution("interrupted-result-timer");
  interrupted.setArgsComplete();
  interrupted.markExecutionStarted();
  interrupted.updateResult(finishedTools, true);
  t.mock.timers.tick(700);
  await runner.emit({ type: "agent_end", messages: [] });
  assert.equal(lastLine(interrupted), "700ms");
  t.mock.timers.tick(1400);
  assert.equal(lastLine(interrupted), "700ms", "cancellation must also freeze the timer");

  const cancelled = await makeExecution("cancelled-codemode");
  cancelled.setExpanded(true);
  await runner.emit({ type: "agent_end", messages: [] });
  cancelled.setExpanded(false);
  assert.doesNotMatch(stripAnsi(cancelled.render(200).join("\n")), /•••/);
  const cancelledRedraws = redraws;
  t.mock.timers.tick(700);
  assert.equal(redraws, cancelledRedraws, "cancellation must not leave animation timers running");

  for (const type of ["session_shutdown", "session_start", "session_tree"]) {
    const pending = await makeExecution(`cleanup-${type}`);
    await runner.emit({ type, oldLeafId: "old", newLeafId: "summary" });
    assert.doesNotMatch(stripAnsi(pending.render(200).join("\n")), /•••/);
    const stoppedRedraws = redraws;
    t.mock.timers.tick(700);
    assert.equal(redraws, stoppedRedraws, `${type} must clean up its animation`);
    const rebuilt = await makeExecution(`cleanup-${type}`, false);
    assert.doesNotMatch(plain(rebuilt), /•••/, `${type} must not reactivate rebuilt history`);
    t.mock.timers.tick(700);
    assert.equal(redraws, stoppedRedraws, "rebuilding a row must not restart its animation");
  }
});
