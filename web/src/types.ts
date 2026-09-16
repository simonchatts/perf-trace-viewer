/* Define the versioned sparse JSON contract shared with the Python backend. */

export type StackEntry = [processIndex: number, percent: number];
export type QuantumSample = [quantumIndex: number, entries: StackEntry[]];

export interface TraceThread {
  id: string;
  tid: number;
  name: string;
  cpuMs: number;
}

export interface TraceProcess {
  id: string;
  kind: "process" | "kernel";
  pid: number | null;
  name: string;
  comm?: string;
  executable?: string;
  commandLine?: string[];
  cpuMs: number;
  firstQuantum: number;
  lastQuantum: number;
  threads: TraceThread[];
}

export interface TraceEvent {
  name: string;
  /** Named integer SDT arguments, for example `{ arg1: 11297, arg2: 11320 }`. */
  args?: Record<string, number>;
  /** Legacy v1 field retained for datasets produced before named arguments. */
  arg1?: number;
  /** Relative to trace.startTimeNs, in milliseconds. */
  timestampMs?: number;
}

export interface TraceEventGroup {
  quantum: number;
  /** SDT provider/category, for example `sdt_processmgr`. */
  category?: string;
  events: TraceEvent[];
}

export interface TraceCpu {
  id: number;
  samples: QuantumSample[];
}

export interface TraceSummary {
  startTimeNs: string;
  durationMs: number;
  quantumMs: number;
  quantumCount: number;
  squelchPercent: number;
  cpuIds: number[];
  busyCpuMs: number;
  otherCpuMs: number;
}

export interface QuantizedTrace {
  schema: "perf-trace-viewer.quantized/v1";
  trace: TraceSummary;
  source: Record<string, string>;
  processes: TraceProcess[];
  cpus: TraceCpu[];
  events: TraceEventGroup[];
}
