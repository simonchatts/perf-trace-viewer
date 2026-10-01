/* Render a horizontally virtualized stacked CPU timeline on a canvas. */

import {
  type CSSProperties,
  type MouseEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  formatDuration,
  formatTimestamp,
  formatTimelineTick,
  processColor,
  sdtColor,
} from "./format";
import type {
  QuantumSample,
  StackEntry,
  TraceCpu,
  TraceEventGroup,
  TraceProcess,
} from "./types";

const AXIS_HEIGHT = 34;
const ROW_HEIGHT = 62;
const BAR_HEIGHT = 45;
const LABEL_WIDTH = 66;
const OTHER_COLOR = "#66798c";
const MIN_BAR_BORDER_WIDTH = 6;

interface ChartProps {
  colorHashSeed: number;
  cpus: TraceCpu[];
  processes: TraceProcess[];
  eventGroups: TraceEventGroup[];
  quantumCount: number;
  quantumMs: number;
  pixelsPerQuantum: number;
  minPixelsPerQuantum: number;
  maxPixelsPerQuantum: number;
  onPixelsPerQuantumChange: (width: number) => void;
  onFitPixelsPerQuantumChange: (width: number) => void;
  onZoomLimitReached: () => void;
  selectedProcess: number | null;
  onSelectProcess: (index: number | null) => void;
}

interface HoveredStack {
  kind: "stack";
  cpu: number;
  quantum: number;
  entries: StackEntry[];
  clientX: number;
  clientY: number;
}

interface HoveredEventGroup {
  kind: "event";
  group: TraceEventGroup;
  clientX: number;
  clientY: number;
}

type HoverTarget = HoveredStack | HoveredEventGroup;

// Turn probe identifiers into concise reader-facing labels.
function eventLabel(
  name: string,
  args?: Record<string, number>,
  legacyArg1?: number,
): string {
  const words = name.replaceAll("_", " ");
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  const displayedArgs =
    args ?? (legacyArg1 === undefined ? undefined : { arg1: legacyArg1 });
  if (!displayedArgs || Object.keys(displayedArgs).length === 0) return label;
  const argumentText = Object.entries(displayedArgs)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return `${label}: ${argumentText}`;
}

// Choose a human-friendly number of quanta between timeline ticks.
function tickStep(pixelsPerQuantum: number): number {
  const target = 110 / pixelsPerQuantum;
  const exponent = 10 ** Math.floor(Math.log10(Math.max(1, target)));
  for (const multiple of [1, 2, 5, 10]) {
    if (multiple * exponent >= target) return multiple * exponent;
  }
  return exponent;
}

// Index sparse CPU samples for constant-time drawing and hit testing.
function indexSamples(
  cpus: TraceCpu[],
): Map<number, Map<number, StackEntry[]>> {
  return new Map(
    cpus.map((cpu) => [
      cpu.id,
      new Map(
        cpu.samples.map(([quantum, entries]: QuantumSample) => [
          quantum,
          entries,
        ]),
      ),
    ]),
  );
}

export function CpuChart({
  colorHashSeed,
  cpus,
  processes,
  eventGroups,
  quantumCount,
  quantumMs,
  pixelsPerQuantum,
  minPixelsPerQuantum,
  maxPixelsPerQuantum,
  onPixelsPerQuantumChange,
  onFitPixelsPerQuantumChange,
  onZoomLimitReached,
  selectedProcess,
  onSelectProcess,
}: ChartProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previousScale = useRef(pixelsPerQuantum);
  const zoomAnchor = useRef<{ quantum: number; viewportX: number } | null>(
    null,
  );
  const mouseViewportX = useRef<number | null>(null);
  const [viewportWidth, setViewportWidth] = useState(900);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [hover, setHover] = useState<HoverTarget | null>(null);
  const sampleIndex = useMemo(() => indexSamples(cpus), [cpus]);
  const sdtColorByCategory = useMemo(() => {
    const categories = new Set(
      eventGroups.map((group) => group.category ?? "sdt_processmgr"),
    );
    return new Map(
      [...categories].map((category) => [
        category,
        sdtColor(category, colorHashSeed),
      ]),
    );
  }, [colorHashSeed, eventGroups]);
  const height = AXIS_HEIGHT + cpus.length * ROW_HEIGHT;
  const timelineWidth = Math.max(
    viewportWidth,
    LABEL_WIDTH + quantumCount * pixelsPerQuantum,
  );

  // Track the viewport and report the exact scale that fits the whole trace.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const updateWidth = () => {
      const width = element.clientWidth;
      setViewportWidth(width);
      onFitPixelsPerQuantumChange(
        Math.min(
          maxPixelsPerQuantum,
          Math.max(0.0001, (width - LABEL_WIDTH) / Math.max(1, quantumCount)),
        ),
      );
    };
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    updateWidth();
    return () => observer.disconnect();
  }, [maxPixelsPerQuantum, onFitPixelsPerQuantumChange, quantumCount]);

  // Keep the pointer or viewport centre fixed when the scale changes.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || previousScale.current === pixelsPerQuantum) return;
    const fallbackX = LABEL_WIDTH + (viewportWidth - LABEL_WIDTH) / 2;
    const anchor = zoomAnchor.current;
    const viewportX = anchor?.viewportX ?? fallbackX;
    const quantum =
      anchor?.quantum ??
      (element.scrollLeft + viewportX - LABEL_WIDTH) / previousScale.current;
    const maxScroll = Math.max(
      0,
      LABEL_WIDTH + quantumCount * pixelsPerQuantum - viewportWidth,
    );
    element.scrollLeft = Math.max(
      0,
      Math.min(maxScroll, LABEL_WIDTH + quantum * pixelsPerQuantum - viewportX),
    );
    setScrollLeft(element.scrollLeft);
    zoomAnchor.current = null;
    previousScale.current = pixelsPerQuantum;
  }, [pixelsPerQuantum, quantumCount, viewportWidth]);

  // Request a bounded zoom while recording the point that should stay fixed.
  function zoomTo(width: number, viewportX?: number) {
    const element = scrollRef.current;
    if (!element) return;
    if (minPixelsPerQuantum >= maxPixelsPerQuantum) {
      onZoomLimitReached();
      return;
    }
    const anchorX =
      viewportX ?? LABEL_WIDTH + (element.clientWidth - LABEL_WIDTH) / 2;
    zoomAnchor.current = {
      quantum: (element.scrollLeft + anchorX - LABEL_WIDTH) / pixelsPerQuantum,
      viewportX: anchorX,
    };
    onPixelsPerQuantumChange(
      Math.max(minPixelsPerQuantum, Math.min(maxPixelsPerQuantum, width)),
    );
  }

  // Add document-level navigation while leaving text entry and shortcuts alone.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.isContentEditable ||
        ["INPUT", "SELECT", "TEXTAREA"].includes(target?.tagName ?? "")
      )
        return;
      const element = scrollRef.current;
      if (!element) return;
      switch (event.key.toLowerCase()) {
        case "w":
          event.preventDefault();
          zoomTo(pixelsPerQuantum * 1.25, mouseViewportX.current ?? undefined);
          break;
        case "s":
          event.preventDefault();
          zoomTo(pixelsPerQuantum / 1.25);
          break;
        case "a":
          event.preventDefault();
          element.scrollBy({ left: -element.clientWidth * 0.35 });
          break;
        case "d":
          event.preventDefault();
          element.scrollBy({ left: element.clientWidth * 0.35 });
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  // Command-wheel zooms around the cursor and suppresses browser page zoom.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const handleWheel = (event: WheelEvent) => {
      if (!event.metaKey) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoomTo(
        pixelsPerQuantum * Math.exp(-event.deltaY * 0.004),
        event.clientX - rect.left,
      );
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  });

  // Draw only quanta intersecting the current horizontal viewport.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(viewportWidth * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${viewportWidth}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, viewportWidth, height);

    context.fillStyle = "#0a2139";
    context.fillRect(0, 0, viewportWidth, height);
    context.fillStyle = "#07182d";
    context.fillRect(0, 0, LABEL_WIDTH, height);

    const firstQuantum = Math.max(0, Math.floor(scrollLeft / pixelsPerQuantum));
    const lastQuantum = Math.min(
      quantumCount - 1,
      Math.ceil((scrollLeft + viewportWidth - LABEL_WIDTH) / pixelsPerQuantum),
    );

    context.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.textBaseline = "middle";
    const step = tickStep(pixelsPerQuantum);
    const firstTick = Math.ceil(firstQuantum / step) * step;
    for (let quantum = firstTick; quantum <= lastQuantum; quantum += step) {
      const x = LABEL_WIDTH + quantum * pixelsPerQuantum - scrollLeft;
      context.strokeStyle = "rgba(152, 186, 209, 0.13)";
      context.beginPath();
      context.moveTo(x + 0.5, AXIS_HEIGHT - 3);
      context.lineTo(x + 0.5, height);
      context.stroke();
      context.fillStyle = "#8faabe";
      context.fillText(
        formatTimelineTick(quantum * quantumMs, step * quantumMs),
        x + 5,
        15,
      );
    }

    const showVerticalBarBorders = pixelsPerQuantum >= MIN_BAR_BORDER_WIDTH;
    // Close sub-6px gaps so dense traces read as continuous columns while
    // the row's horizontal guide remains visible.
    const barWidth = showVerticalBarBorders
      ? Math.max(
          0.05,
          pixelsPerQuantum - Math.min(0.35, pixelsPerQuantum * 0.08),
        )
      : pixelsPerQuantum;
    const fillPaths = new Map<
      number,
      { path: Path2D; color: string; alpha: number }
    >();
    const selectedOutlinePath = new Path2D();

    cpus.forEach((cpu, row) => {
      const rowTop = AXIS_HEIGHT + row * ROW_HEIGHT;
      const baseline = rowTop + BAR_HEIGHT + 5;
      context.fillStyle = row % 2 ? "rgba(255,255,255,0.018)" : "transparent";
      context.fillRect(
        LABEL_WIDTH,
        rowTop,
        viewportWidth - LABEL_WIDTH,
        ROW_HEIGHT,
      );
      context.strokeStyle = "rgba(152, 186, 209, 0.14)";
      context.beginPath();
      context.moveTo(LABEL_WIDTH, baseline + 0.5);
      context.lineTo(viewportWidth, baseline + 0.5);
      context.stroke();
      context.fillStyle = "#d9f7ff";
      context.font = "600 12px system-ui, sans-serif";
      context.fillText(`CPU ${cpu.id}`, 12, rowTop + BAR_HEIGHT / 2 + 4);

      // Sparse iteration avoids walking every empty quantum at fit-to-window.
      for (const [quantum, entries] of cpu.samples) {
        if (quantum < firstQuantum) continue;
        if (quantum > lastQuantum) break;
        const x = LABEL_WIDTH + quantum * pixelsPerQuantum - scrollLeft;
        let stackedPercent = 0;
        for (const [processIndex, percent] of entries) {
          const segmentHeight = Math.max(
            0,
            Math.min(100 - stackedPercent, percent),
          );
          const y =
            baseline - ((stackedPercent + segmentHeight) / 100) * BAR_HEIGHT;
          const selected = selectedProcess === processIndex;
          let fillPath = fillPaths.get(processIndex);
          if (!fillPath) {
            fillPath = {
              path: new Path2D(),
              color:
                processIndex === -1
                  ? OTHER_COLOR
                  : processColor(processes[processIndex].name, colorHashSeed),
              alpha:
                selectedProcess === null || selected
                  ? 0.92
                  : processIndex === -1
                    ? 0.12
                    : 0.16,
            };
            fillPaths.set(processIndex, fillPath);
          }
          const segmentHeightPx = (segmentHeight / 100) * BAR_HEIGHT;
          fillPath.path.rect(x, y, barWidth, segmentHeightPx);
          if (selected) {
            if (showVerticalBarBorders) {
              selectedOutlinePath.rect(
                x + 0.5,
                y + 0.5,
                Math.max(0, barWidth - 1),
                Math.max(0, segmentHeightPx - 1),
              );
            } else {
              // Preserve selection's top and bottom edges without adding
              // distracting vertical strokes to very narrow bars.
              selectedOutlinePath.moveTo(x, y + 0.5);
              selectedOutlinePath.lineTo(x + barWidth, y + 0.5);
              selectedOutlinePath.moveTo(x, y + segmentHeightPx - 0.5);
              selectedOutlinePath.lineTo(
                x + barWidth,
                y + segmentHeightPx - 0.5,
              );
            }
          }
          stackedPercent += segmentHeight;
        }
      }
    });

    // Fill each process as one shape so adjacent quantum edges are rasterized
    // together instead of repeatedly alpha-composited.
    for (const { path, color, alpha } of fillPaths.values()) {
      context.globalAlpha = alpha;
      context.fillStyle = color;
      context.fill(path);
    }
    context.globalAlpha = 1;
    if (selectedProcess !== null) {
      context.strokeStyle = "#ffffff";
      context.lineWidth = 1;
      context.stroke(selectedOutlinePath);
    }

    // SDT markers sit on the left boundary of their containing quantum and
    // span every CPU row, with a generous target in the axis gutter.
    for (const group of eventGroups) {
      if (group.quantum < firstQuantum || group.quantum > lastQuantum) continue;
      const x = LABEL_WIDTH + group.quantum * pixelsPerQuantum - scrollLeft;
      const category = group.category ?? "sdt_processmgr";
      const color =
        sdtColorByCategory.get(category) ?? sdtColor(category, colorHashSeed);
      context.strokeStyle = color;
      context.globalAlpha = 0.82;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x + 0.5, AXIS_HEIGHT);
      context.lineTo(x + 0.5, height);
      context.stroke();
      context.globalAlpha = 1;
      context.fillStyle = color;
      context.fillRect(x - 6, AXIS_HEIGHT - 13, 12, 11);
    }

    context.strokeStyle = "rgba(152, 186, 209, 0.2)";
    context.beginPath();
    context.moveTo(LABEL_WIDTH + 0.5, 0);
    context.lineTo(LABEL_WIDTH + 0.5, height);
    context.stroke();
  }, [
    cpus,
    colorHashSeed,
    eventGroups,
    height,
    pixelsPerQuantum,
    processes,
    quantumCount,
    quantumMs,
    sampleIndex,
    sdtColorByCategory,
    scrollLeft,
    selectedProcess,
    viewportWidth,
  ]);

  // Resolve a pointer position to its CPU and sparse quantum sample.
  function hitTest(event: MouseEvent<HTMLCanvasElement>): HoverTarget | null {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < LABEL_WIDTH) return null;
    if (y < AXIS_HEIGHT) {
      const quantumAtPointer =
        (x - LABEL_WIDTH + scrollLeft) / pixelsPerQuantum;
      const group = eventGroups.find(
        (candidate) =>
          Math.abs(candidate.quantum - quantumAtPointer) * pixelsPerQuantum <=
          7,
      );
      return group
        ? {
            kind: "event",
            group,
            clientX: event.clientX,
            clientY: event.clientY,
          }
        : null;
    }
    const row = Math.floor((y - AXIS_HEIGHT) / ROW_HEIGHT);
    const cpu = cpus[row];
    if (!cpu) return null;
    const quantum = Math.floor(
      (x - LABEL_WIDTH + scrollLeft) / pixelsPerQuantum,
    );
    const entries = sampleIndex.get(cpu.id)?.get(quantum);
    if (!entries) return null;
    return {
      kind: "stack",
      cpu: cpu.id,
      quantum,
      entries,
      clientX: event.clientX,
      clientY: event.clientY,
    };
  }

  // Select the exact stack segment under a click, or clear selection on idle.
  function handleClick(event: MouseEvent<HTMLCanvasElement>) {
    const target = hitTest(event);
    if (!target || target.kind === "event") {
      if (!target) onSelectProcess(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const row = cpus.findIndex((cpu) => cpu.id === target.cpu);
    const rowTop = AXIS_HEIGHT + row * ROW_HEIGHT;
    const baseline = rowTop + BAR_HEIGHT + 5;
    const percentFromBottom =
      ((baseline - (event.clientY - rect.top)) / BAR_HEIGHT) * 100;
    let total = 0;
    const entry = target.entries.find(([, percent]) => {
      total += percent;
      return percentFromBottom <= total;
    });
    onSelectProcess(entry && entry[0] >= 0 ? entry[0] : null);
  }

  // Remember the cursor's viewport position so keyboard zoom can use it.
  function handleMouseMove(event: MouseEvent<HTMLCanvasElement>) {
    const scrollElement = scrollRef.current;
    if (scrollElement) {
      mouseViewportX.current =
        event.clientX - scrollElement.getBoundingClientRect().left;
    }
    setHover(hitTest(event));
  }

  return (
    <div className="chart-shell">
      <div
        className="chart-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          setScrollLeft(event.currentTarget.scrollLeft);
          setHover(null);
        }}
      >
        <div className="chart-stage" style={{ width: timelineWidth, height }}>
          <canvas
            ref={canvasRef}
            className="cpu-canvas"
            onMouseEnter={handleMouseMove}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => {
              mouseViewportX.current = null;
              setHover(null);
            }}
            onClick={handleClick}
          />
        </div>
      </div>
      {hover && (
        <div
          className="chart-tooltip"
          style={{
            left: Math.min(hover.clientX + 14, window.innerWidth - 280),
            top: hover.clientY + 14,
          }}
        >
          {hover.kind === "event" ? (
            <div
              className="event-popover"
              style={
                {
                  "--event-color":
                    sdtColorByCategory.get(
                      hover.group.category ?? "sdt_processmgr",
                    ) ??
                    sdtColor(
                      hover.group.category ?? "sdt_processmgr",
                      colorHashSeed,
                    ),
                } as CSSProperties
              }
            >
              <small>{hover.group.category ?? "sdt_processmgr"}</small>
              <ul>
                {hover.group.events.map((event, index) => (
                  <li
                    key={`${event.name}:${JSON.stringify(event.args)}:${event.arg1 ?? ""}:${index}`}
                  >
                    <time>
                      {formatTimestamp(
                        event.timestampMs ?? hover.group.quantum * quantumMs,
                      )}
                    </time>{" "}
                    {event.label ??
                      eventLabel(event.name, event.args, event.arg1)}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <>
              <strong>
                CPU {hover.cpu} · {formatTimestamp(hover.quantum * quantumMs)}–
                {formatTimestamp((hover.quantum + 1) * quantumMs)}
              </strong>
              {hover.entries
                .slice()
                .sort((a, b) => b[1] - a[1])
                .map(([index, percent]) => (
                  <span key={index}>
                    <i
                      style={{
                        background:
                          index === -1
                            ? OTHER_COLOR
                            : processColor(
                                processes[index].name,
                                colorHashSeed,
                              ),
                      }}
                    />
                    {index === -1 ? "Other" : processes[index].name}
                    <b>{percent.toFixed(2)}%</b>
                  </span>
                ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
