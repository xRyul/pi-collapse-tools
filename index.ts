/**
 * Collapse Tools Extension
 *
 * Shows full tool call with parameters, but hides output by default.
 * Press Cmd+O (or Ctrl+O) to expand and view full output.
 *
 * Note: extension-registered tools are enabled by default in pi. To avoid
 * accidentally enabling tools the user did not request, this extension only
 * overrides the built-in tools enabled via `--tools` / `--no-tools`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// Render the tool call line showing tool name + key parameters
function makeRenderCall(toolName: string) {
  return (args: any, theme: any) => {
    const title = theme.fg("toolTitle", theme.bold(toolName));
    let params = "";

    switch (toolName) {
      case "bash":
        params = theme.fg("muted", args.command ?? "");
        if (args.timeout) params += theme.fg("dim", ` (timeout: ${args.timeout}s)`);
        break;
      case "read":
        params = theme.fg("accent", args.path ?? "");
        if (args.offset) params += theme.fg("dim", ` offset=${args.offset}`);
        if (args.limit) params += theme.fg("dim", ` limit=${args.limit}`);
        break;
      case "write":
        params = theme.fg("accent", args.path ?? "");
        break;
      case "edit":
        params = theme.fg("accent", args.path ?? "");
        break;
      case "grep":
        params = theme.fg("accent", args.pattern ?? "");
        if (args.path) params += " " + theme.fg("muted", args.path);
        if (args.glob) params += " " + theme.fg("dim", args.glob);
        break;
      case "find":
        params = theme.fg("accent", args.pattern ?? "");
        if (args.path) params += " " + theme.fg("muted", args.path);
        break;
      case "ls":
        params = theme.fg("accent", args.path ?? ".");
        break;
      default:
        params = theme.fg("dim", JSON.stringify(args));
    }

    return new Text(`${title} ${params}`, 0, 0);
  };
}

function renderSimpleDiff(diffText: string, theme: any): string {
  return diffText
    .split("\n")
    .map((line) => {
      const clean = line.replace(/\t/g, "   ");
      if (clean.startsWith("+")) return theme.fg("toolDiffAdded", clean);
      if (clean.startsWith("-")) return theme.fg("toolDiffRemoved", clean);
      return theme.fg("toolDiffContext", clean);
    })
    .join("\n");
}

const ORIGINAL_RESULT_COMPONENT = Symbol("pi-collapse-tools.originalResultComponent");

// Render the result: hidden by default, shown when expanded
function makeRenderResult(toolName: string, originalRenderResult?: any) {
  return (result: any, options: any, theme: any, context: any) => {
    const { expanded, isPartial } = options;

    if (isPartial) {
      // Keep a tiny indicator while running (remove if you want it completely silent)
      return new Text(theme.fg("dim", "Running..."), 0, 0);
    }

    // Collapsed: render a valid empty component so current pi versions do not crash.
    if (!expanded) {
      return new Text("", 0, 0);
    }

    // Expanded: special-case edit to show diff (matches default behavior much better)
    if (toolName === "edit") {
      const diff = result.details?.diff;
      if (typeof diff === "string" && diff.trim().length > 0) {
        return new Text("\n" + renderSimpleDiff(diff, theme), 0, 0);
      }
    }

    // Track the built-in renderer's component separately. The collapsed renderer
    // returns Text, which may not match the component type the built-in expects.
    if (originalRenderResult) {
      const originalContext = {
        ...context,
        lastComponent: context.state[ORIGINAL_RESULT_COMPONENT],
      };
      const component = originalRenderResult(result, options, theme, originalContext);
      context.state[ORIGINAL_RESULT_COMPONENT] = component;
      return component;
    }

    // Expanded fallback: show raw text content
    const content = result.content?.find((c: any) => c.type === "text");
    const text = content?.type === "text" ? content.text : "";
    return new Text(text ? "\n" + theme.fg("toolOutput", text) : "", 0, 0);
  };
}

type BuiltInToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

const VALID_TOOL_NAMES: BuiltInToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const VALID_TOOL_SET = new Set<string>(VALID_TOOL_NAMES);
const DEFAULT_TOOL_NAMES: BuiltInToolName[] = ["read", "bash", "edit", "write"];

function parseToolSelectionFromArgv(argv: string[]): {
  noTools: boolean;
  noBuiltinTools: boolean;
  tools?: BuiltInToolName[];
} {
  let noTools = false;
  let noBuiltinTools = false;
  let toolsRaw: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-tools" || arg === "-nt") {
      noTools = true;
      continue;
    }

    if (arg === "--no-builtin-tools" || arg === "-nbt") {
      noBuiltinTools = true;
      continue;
    }

    // Support pi's long + short flag forms, including `--tools=<list>` / `-t=<list>`.
    if ((arg === "--tools" || arg === "-t") && i + 1 < argv.length) {
      toolsRaw = argv[i + 1];
      i++;
      continue;
    }

    if (arg.startsWith("--tools=")) {
      toolsRaw = arg.slice("--tools=".length);
      continue;
    }

    if (arg.startsWith("-t=")) {
      toolsRaw = arg.slice("-t=".length);
      continue;
    }
  }

  if (!toolsRaw) return { noTools, noBuiltinTools, tools: undefined };

  const parsed = toolsRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((name) => VALID_TOOL_SET.has(name)) as BuiltInToolName[];

  // Dedupe while keeping order
  const seen = new Set<string>();
  const tools = parsed.filter((name) => (seen.has(name) ? false : (seen.add(name), true)));

  return { noTools, noBuiltinTools, tools };
}

function getToolNamesToOverride(): BuiltInToolName[] {
  const { noTools, noBuiltinTools, tools } = parseToolSelectionFromArgv(process.argv.slice(2));

  // Mirror pi semantics for built-in tool wrapping:
  // - default: read,bash,edit,write
  // - --tools / -t: explicit allowlist (filtered to built-in tool names)
  // - --no-tools / -nt: none (unless --tools is also specified)
  // - --no-builtin-tools / -nbt: built-ins disabled by default, unless explicitly allowlisted
  if (noTools) return tools ?? [];
  if (noBuiltinTools) return tools ?? [];
  return tools ?? DEFAULT_TOOL_NAMES;
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const toolNames = getToolNamesToOverride();

  const factories: Record<BuiltInToolName, () => any> = {
    read: () => createReadToolDefinition(cwd),
    bash: () => createBashToolDefinition(cwd),
    write: () => createWriteToolDefinition(cwd),
    edit: () => createEditToolDefinition(cwd),
    grep: () => createGrepToolDefinition(cwd),
    find: () => createFindToolDefinition(cwd),
    ls: () => createLsToolDefinition(cwd),
  };

  for (const name of toolNames) {
    const tool = factories[name]();
    pi.registerTool({
      ...tool,
      renderCall: makeRenderCall(tool.name),
      renderResult: makeRenderResult(tool.name, tool.renderResult),
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    const wrapped = toolNames.length > 0 ? toolNames.join(", ") : "none";
    ctx.ui.notify(`Collapse Tools: outputs hidden (Cmd+O to expand) • wrapped: ${wrapped}`, "info");
  });
}
