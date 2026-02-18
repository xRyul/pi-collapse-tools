/**
 * Collapse Tools Extension
 *
 * Shows full tool call with parameters, but hides output by default.
 * Press Cmd+O (or Ctrl+O) to expand and view full output.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createBashTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

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

// Render the result: hidden by default, shown when expanded
function makeRenderResult(toolName: string, originalRenderResult?: any) {
  return (result: any, options: any, theme: any) => {
    const { expanded, isPartial } = options;

    if (isPartial) {
      // Keep a tiny indicator while running (remove if you want it completely silent)
      return new Text(theme.fg("dim", "Running..."), 0, 0);
    }

    // Collapsed: render nothing under the call
    if (!expanded) {
      return null;
    }

    // Expanded: special-case edit to show diff (matches default behavior much better)
    if (toolName === "edit") {
      const diff = result.details?.diff;
      if (typeof diff === "string" && diff.trim().length > 0) {
        return new Text("\n" + renderSimpleDiff(diff, theme), 0, 0);
      }
    }

    // Expanded: use original renderer if available
    if (originalRenderResult) {
      return originalRenderResult(result, options, theme);
    }

    // Expanded fallback: show raw text content
    const content = result.content?.find((c: any) => c.type === "text");
    const text = content?.type === "text" ? content.text : "";
    return new Text(text ? "\n" + theme.fg("toolOutput", text) : "", 0, 0);
  };
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  const tools = [
    createReadTool(cwd),
    createBashTool(cwd),
    createWriteTool(cwd),
    createEditTool(cwd),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
  ];

  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      execute: tool.execute,
      renderCall: makeRenderCall(tool.name),
      renderResult: makeRenderResult(tool.name, tool.renderResult),
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Collapse Tools: outputs hidden (Cmd+O to expand)", "info");
  });
}
