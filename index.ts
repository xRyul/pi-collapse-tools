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

import type { CodemodeToolDetails, ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  estimateTokens,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

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

const ORIGINAL_CALL_COMPONENT = Symbol("pi-collapse-tools.originalCallComponent");
const CODEMODE_INDICATOR_FINISHED = Symbol("pi-collapse-tools.codemodeIndicatorFinished");
const CODEMODE_RESULT_TIMER = Symbol("pi-collapse-tools.codemodeResultTimer");
type CodemodeIndicator = {
  timer?: ReturnType<typeof setInterval>;
  finish: () => void;
};
type CollapseCodemodeDetails = CodemodeToolDetails & { collapseToolsContextWindow?: number };

function formatCodemodeTokens(tokens: number, contextWindow?: number): string {
  const summary = `Tokens ~${tokens.toLocaleString("en-US")}`;
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return summary;
  }
  const percent = (tokens / contextWindow) * 100;
  const percentage = percent > 0 && percent < 0.001 ? "<0.001" : percent.toFixed(3);
  return `${summary} (${percentage}%)`;
}

function makeCodemodeRenderers(
  original: ToolRenderers,
  indicators: Map<string, CodemodeIndicator>,
): ToolRenderers {
  return {
    ...original,
    renderCall(args, theme, context) {
      const busy = context.isPartial && !context.state[CODEMODE_INDICATOR_FINISHED];
      let indicator = indicators.get(context.toolCallId);
      if (busy && !indicator) {
        const entry: CodemodeIndicator = {
          finish() {
            context.state[CODEMODE_INDICATOR_FINISHED] = true;
            clearInterval(entry.timer);
            indicators.delete(context.toolCallId);
            context.invalidate();
          },
        };
        indicators.set(context.toolCallId, entry);
        indicator = entry;
      }
      if (indicator) {
        if (!busy || context.expanded) {
          clearInterval(indicator.timer);
          indicator.timer = undefined;
          if (!busy) indicators.delete(context.toolCallId);
        } else if (!indicator.timer) {
          indicator.timer = setInterval(context.invalidate, 350);
          indicator.timer.unref();
        }
      }
      if (context.expanded && original.renderCall) {
        const component = original.renderCall(args, theme, {
          ...context, lastComponent: context.state[ORIGINAL_CALL_COMPONENT],
        });
        context.state[ORIGINAL_CALL_COMPONENT] = component;
        return component;
      }
      const title = theme.fg("toolTitle", theme.bold("codemode"));
      const frame = Math.floor(Date.now() / 350) % 3;
      const dots = busy ? " " + [0, 1, 2].map((dot) =>
        theme.fg(dot === frame ? "warning" : "dim", "•"),
      ).join("") : "";
      return new Text(title + dots, 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (!original.renderResult) return new Text("", 0, 0);
      const details = result.details as CollapseCodemodeDetails | undefined;
      const calls = details?.calls ?? [];
      let clock = context.state[CODEMODE_RESULT_TIMER] as {
        startedAt: number; finishedAt?: number;
      } | undefined;
      const toolsFinished = context.executionStarted && calls.length > 0 &&
        calls.every((call) => call.status !== "running");
      if (!toolsFinished) {
        delete context.state[CODEMODE_RESULT_TIMER];
        clock = undefined;
      } else if (!clock && options.isPartial && !context.state[CODEMODE_INDICATOR_FINISHED]) {
        clock = { startedAt: Date.now() };
        context.state[CODEMODE_RESULT_TIMER] = clock;
      }
      if (clock && (!options.isPartial || context.state[CODEMODE_INDICATOR_FINISHED])) {
        clock.finishedAt ??= Date.now();
      }
      // Keep the native call rows (arguments, timing, cost); hide only script output.
      const visibleResult = options.expanded ? result : { ...result, content: [] };
      const component = original.renderResult(visibleResult, options, theme, {
        ...context, lastComponent: context.state[ORIGINAL_RESULT_COMPONENT],
      });
      if (!options.expanded && component instanceof Container && component.children[0] instanceof Spacer) {
        component.removeChild(component.children[0]);
      }
      if (!options.expanded && component instanceof Container) {
        const footer: string[] = [];
        if (clock) {
          const elapsedMs = Math.max(0, (clock.finishedAt ?? Date.now()) - clock.startedAt);
          footer.push(elapsedMs < 1000 ? `${Math.round(elapsedMs)}ms` : `${(elapsedMs / 1000).toFixed(1)}s`);
        }
        if (!options.isPartial) {
          // Estimate the actual returned content, not the empty collapsed preview.
          const tokens = estimateTokens({
            role: "toolResult", toolCallId: context.toolCallId, toolName: "codemode",
            content: result.content ?? [], isError: context.isError, timestamp: 0,
          });
          footer.push(formatCodemodeTokens(tokens, details?.collapseToolsContextWindow));
        }
        if (footer.length > 0) {
          component.addChild(new Text(theme.fg("dim", footer.join(" · ")), 0, 0));
        }
      }
      context.state[ORIGINAL_RESULT_COMPONENT] = component;
      return component;
    },
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
  const indicators = new Map<string, CodemodeIndicator>();
  const stopIndicators = () => {
    for (const indicator of indicators.values()) indicator.finish();
  };
  pi.on("agent_end", stopIndicators);
  pi.on("session_shutdown", stopIndicators);
  pi.on("session_start", stopIndicators);

  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "codemode") return;
    // Persist UI-only context capacity without changing model-facing output.
    return {
      details: {
        ...(event.details as CodemodeToolDetails | undefined),
        collapseToolsContextWindow: ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow,
      },
    };
  });

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

  // Always resolve the existing renderer: returning undefined would hide it.
  pi.registerToolRenderer?.((name, next) => {
    const original = next();
    if (name !== "codemode" || !original) return original;
    return makeCodemodeRenderers(original, indicators);
  });

  pi.on("session_start", async (_event, ctx) => {
    const wrapped = toolNames.length > 0 ? toolNames.join(", ") : "none";
    ctx.ui.notify(`Collapse Tools: outputs hidden (Cmd+O to expand) • wrapped: ${wrapped}`, "info");
  });
}
