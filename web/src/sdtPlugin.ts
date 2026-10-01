/* Compile SDT plugin rules and apply their display transformations. */

import type {
  PidTableEntry,
  QuantizedTrace,
  TraceEvent,
  TraceEventGroup,
} from "./types";

export const PLUGIN_STORAGE_KEY = "perf-trace-viewer.sdt-plugin.v1";

export const PLUGIN_EXAMPLE = `[
  // Map sdt_processmgr:band_remaining arguments to process names, skipping zero values
  {
    category: "sdt_processmgr",
    name: "band_remaining",
    transform: (event, context) => {
      const pids = Object.values(event.args ?? {}).filter((pid) => pid !== 0);
      const names = pids.map((pid) => {
        const matches = context.lookupPid(pid);
        return \`\${matches.map((item) => item.name).join(" / ") || "?"} (pid \${pid})\`;
      });
      return {
        category: "process_manager",
        label: \`band remaining: \${names.join(", ")}\`,
      };
    },
  },
  // This example does nothing, but illustrates the pattern matching and no-op capabilities
  { category: "*", name: "*", transform: (event, context) => { return null; } }
]`;

export interface SdtPluginEvent extends TraceEvent {
  category: string;
  quantum: number;
}

export interface PidMatch {
  id: string;
  pid: number;
  name: string;
}

export interface SdtPluginContext {
  lookupPid(pid: number): PidMatch[];
}

interface SdtPluginResult {
  category: string;
  label: string;
}

interface SdtPluginRule {
  category: string;
  name: string;
  transform: (
    event: SdtPluginEvent,
    context: SdtPluginContext,
  ) => SdtPluginResult | null | undefined;
}

interface CompiledRule {
  category: RegExp;
  name: RegExp;
  transform: SdtPluginRule["transform"];
}

// Compile a full-string glob with * and ? wildcards.
function globPattern(glob: string): RegExp {
  const escaped = [...glob]
    .map((character) => {
      if (character === "*") return ".*";
      if (character === "?") return ".";
      return character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${escaped}$`);
}

// Check JavaScript syntax without evaluating the editor's draft expression.
export function checkPluginSyntax(source: string): void {
  if (source.trim()) new Function(`"use strict"; return (${source});`);
}

// Parse the user's array expression and check each rule's required fields.
export function compilePlugin(source: string): CompiledRule[] {
  if (!source.trim()) return [];
  checkPluginSyntax(source);
  const value: unknown = new Function(`"use strict"; return (${source});`)();
  if (!Array.isArray(value)) {
    throw new Error("The plugin must be a JavaScript array of rules.");
  }
  return value.map((rule: unknown, index: number) => {
    if (!rule || typeof rule !== "object") {
      throw new Error(`Rule ${index + 1} must be an object.`);
    }
    const candidate = rule as Partial<SdtPluginRule>;
    if (
      typeof candidate.category !== "string" ||
      typeof candidate.name !== "string" ||
      typeof candidate.transform !== "function"
    ) {
      throw new Error(
        `Rule ${index + 1} needs string category/name globs and a transform function.`,
      );
    }
    return {
      category: globPattern(candidate.category),
      name: globPattern(candidate.name),
      transform: candidate.transform,
    };
  });
}

// Resolve every process identity sharing a numeric PID, including reused PIDs.
function pidContext(trace: QuantizedTrace): SdtPluginContext {
  const entries: PidTableEntry[] =
    trace.pidTable ??
    trace.processes.map((process, index) => ({
      ...process,
      visibleProcessIndex: index,
    }));
  const byPid = new Map<number, PidMatch[]>();
  for (const entry of entries) {
    if (entry.pid === null) continue;
    const matches = byPid.get(entry.pid) ?? [];
    matches.push({ id: entry.id, pid: entry.pid, name: entry.name });
    byPid.set(entry.pid, matches);
  }
  return {
    lookupPid: (pid) => byPid.get(pid)?.map((match) => ({ ...match })) ?? [],
  };
}

// Apply the first matching rule that returns a result, then regroup for colours.
export function transformSdtEvents(
  trace: QuantizedTrace,
  rules: CompiledRule[],
): TraceEventGroup[] {
  if (rules.length === 0) return trace.events;
  const context = pidContext(trace);
  const groups = new Map<string, TraceEventGroup>();
  for (const group of trace.events) {
    const category = group.category ?? "sdt_processmgr";
    for (const event of group.events) {
      let displayed: TraceEvent = event;
      let displayedCategory = category;
      for (const [index, rule] of rules.entries()) {
        if (!rule.category.test(category) || !rule.name.test(event.name)) {
          continue;
        }
        let result: SdtPluginResult | null | undefined;
        try {
          result = rule.transform(
            {
              ...event,
              args: event.args && { ...event.args },
              category,
              quantum: group.quantum,
            },
            context,
          );
        } catch (reason) {
          throw new Error(
            `Rule ${index + 1} failed on ${category}:${event.name}: ${String(reason)}`,
          );
        }
        if (result == null) continue;
        if (
          typeof result !== "object" ||
          typeof result.category !== "string" ||
          !result.category ||
          typeof result.label !== "string"
        ) {
          throw new Error(
            `Rule ${index + 1} returned an invalid result for ${category}:${event.name}. Expected { category, label }.`,
          );
        }
        displayedCategory = result.category;
        displayed = { ...event, label: result.label };
        break;
      }
      const key = JSON.stringify([group.quantum, displayedCategory]);
      let target = groups.get(key);
      if (!target) {
        target = {
          quantum: group.quantum,
          category: displayedCategory,
          events: [],
        };
        groups.set(key, target);
      }
      target.events.push(displayed);
    }
  }
  return [...groups.values()].sort(
    (left, right) =>
      left.quantum - right.quantum ||
      (left.category ?? "").localeCompare(right.category ?? ""),
  );
}
