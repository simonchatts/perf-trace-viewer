/* Provide shared formatting, color, and runtime validation helpers. */

import type { QuantizedTrace } from "./types";

const PROCESS_COLORS = [
  "#02c8ff",
  "#ff007f",
  "#ff9000",
  "#69e82f",
  "#8b7cff",
  "#00e0b8",
  "#ff5f57",
  "#f0db4f",
  "#47a8ff",
  "#c879ff",
];

// Tune this seed if a dataset's common names produce an inconvenient colour mix.
export const COLOR_HASH_SEED = 46;

/* Hash a name into a stable index for the shared trace colour palette. */
function colorIndex(name: string, seed: number): number {
  let hash = seed;
  for (const character of name) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % PROCESS_COLORS.length;
}

// Return a stable vivid colour based on the displayed process name.
export function processColor(
  name: string,
  seed: number = COLOR_HASH_SEED,
): string {
  return PROCESS_COLORS[colorIndex(name, seed)];
}

// Return a stable vivid colour based on the SDT category name.
export function sdtColor(
  category: string,
  seed: number = COLOR_HASH_SEED,
): string {
  return PROCESS_COLORS[colorIndex(category, seed)];
}

// Render milliseconds at a useful human scale.
export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1) return `${(milliseconds * 1000).toFixed(1)} µs`;
  if (milliseconds < 1000) return `${milliseconds.toFixed(1)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(2)} s`;
  if (milliseconds < 3_600_000)
    return `${(milliseconds / 60_000).toFixed(2)} min`;
  return `${(milliseconds / 3_600_000).toFixed(2)} h`;
}

/* Format a trace offset with clock-like fields and precision when available. */
export function formatTimestamp(milliseconds: number): string {
  if (milliseconds < 1) return `${(milliseconds * 1000).toFixed(1)} µs`;
  if (milliseconds < 1000) return `${Number(milliseconds.toFixed(1))} ms`;

  const totalCentiseconds = Math.max(0, Math.round(milliseconds / 10));
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const centiseconds = totalCentiseconds % 100;
  const seconds = totalSeconds % 60;

  if (totalSeconds < 60) {
    return centiseconds
      ? `${totalSeconds}.${centiseconds.toString().padStart(2, "0")} s`
      : `${totalSeconds} s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  if (totalMinutes < 60) {
    return centiseconds
      ? `${totalMinutes}:${seconds.toString().padStart(2, "0")}:${centiseconds
          .toString()
          .padStart(2, "0")}`
      : `${totalMinutes}:${seconds.toString().padStart(2, "0")} min`;
  }

  const hours = Math.floor(totalMinutes / 60);
  return centiseconds
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds
        .toString()
        .padStart(2, "0")}:${centiseconds.toString().padStart(2, "0")}`
    : `${hours}:${minutes.toString().padStart(2, "0")}:${seconds
        .toString()
        .padStart(2, "0")} h`;
}

/* Format an axis tick using its interval to choose a readable zero unit. */
export function formatTimelineTick(
  milliseconds: number,
  tickIntervalMilliseconds: number,
): string {
  if (milliseconds === 0) {
    return tickIntervalMilliseconds < 1000 ? "0 ms" : "0 s";
  }
  return formatTimestamp(milliseconds);
}

// Format a quantum index as an offset from the viewed trace start.
export function formatQuantum(index: number, quantumMs: number): string {
  return formatTimestamp(index * quantumMs);
}

// Check the schema and enough shape to give useful load errors.
export function validateTrace(value: unknown): QuantizedTrace {
  if (!value || typeof value !== "object") {
    throw new Error("The selected file does not contain a JSON object.");
  }
  const candidate = value as Partial<QuantizedTrace>;
  if (candidate.schema !== "perf-trace-viewer.quantized/v1") {
    throw new Error(
      `Unsupported data schema: ${String(candidate.schema ?? "missing")}`,
    );
  }
  if (
    !candidate.trace ||
    !Array.isArray(candidate.processes) ||
    !Array.isArray(candidate.cpus)
  ) {
    throw new Error("The quantized dataset is incomplete.");
  }
  return {
    ...(candidate as QuantizedTrace),
    events: Array.isArray(candidate.events) ? candidate.events : [],
  };
}
