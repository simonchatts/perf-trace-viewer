/* Load quantized datasets and compose the interactive scheduling dashboard. */

import {
  type DragEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { CpuChart } from "./CpuChart";
import { formatDuration, validateTrace } from "./format";
import { ProcessTable } from "./ProcessTable";
import type { QuantizedTrace } from "./types";

type LoadState = "empty" | "loading" | "ready" | "error";

const MAX_PIXELS_PER_QUANTUM = 100;

// Map pixel widths logarithmically so long traces retain useful slider control.
function zoomToSliderValue(width: number, fitWidth: number): number {
  if (fitWidth >= MAX_PIXELS_PER_QUANTUM) return 0;
  return (
    (Math.log(width / fitWidth) / Math.log(MAX_PIXELS_PER_QUANTUM / fitWidth)) *
    1000
  );
}

// Convert the normalized slider position back into a pixel width.
function sliderValueToZoom(value: number, fitWidth: number): number {
  if (fitWidth >= MAX_PIXELS_PER_QUANTUM) return fitWidth;
  return (
    fitWidth *
    (MAX_PIXELS_PER_QUANTUM / fitWidth) ** (Math.max(0, value) / 1000)
  );
}

// Parse and validate a trace response without retaining the input string.
async function parseResponse(response: Response): Promise<QuantizedTrace> {
  if (!response.ok)
    throw new Error(`Dataset request failed (${response.status}).`);
  return validateTrace(await response.json());
}

export function App() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [trace, setTrace] = useState<QuantizedTrace | null>(null);
  const [state, setState] = useState<LoadState>("empty");
  const [error, setError] = useState("");
  const [datasetName, setDatasetName] = useState("");
  const [selectedProcess, setSelectedProcess] = useState<number | null>(null);
  const [fitPixelsPerQuantum, setFitPixelsPerQuantum] = useState(1);
  const [pixelsPerQuantum, setPixelsPerQuantum] = useState(1);
  const previousFitWidth = useRef<number | null>(null);

  // Follow viewport changes while fitted, but preserve deliberate user zooms.
  const handleFitWidthChange = useCallback((nextFitWidth: number) => {
    const oldFitWidth = previousFitWidth.current;
    previousFitWidth.current = nextFitWidth;
    setFitPixelsPerQuantum(nextFitWidth);
    setPixelsPerQuantum((currentWidth) => {
      const wasFitted =
        oldFitWidth === null ||
        Math.abs(currentWidth - oldFitWidth) <=
          Math.max(0.001, oldFitWidth * 0.001);
      return wasFitted ? nextFitWidth : Math.max(nextFitWidth, currentWidth);
    });
  }, []);

  // Load a URL supplied explicitly with ?data= for static deployments.
  useEffect(() => {
    const dataUrl = new URLSearchParams(window.location.search).get("data");
    if (!dataUrl) return;
    setState("loading");
    fetch(dataUrl)
      .then(parseResponse)
      .then((data) => {
        setTrace(data);
        setDatasetName(dataUrl.split("/").pop() || dataUrl);
        setState("ready");
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        setState("error");
      });
  }, []);

  // Read a local JSON dataset chosen or dropped by the user.
  async function loadFile(file: File) {
    setState("loading");
    setError("");
    setSelectedProcess(null);
    try {
      const data = validateTrace(JSON.parse(await file.text()) as unknown);
      setTrace(data);
      setDatasetName(file.name);
      setState("ready");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setState("error");
    }
  }

  // Accept a dropped file anywhere on the welcome panel.
  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files.item(0);
    if (file) void loadFile(file);
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <img src="./icon.svg" alt="" width="42" height="42" />
          <div>
            <span>Perf Trace Viewer</span>
            <strong>Quantized CPU atlas</strong>
          </div>
        </div>
        <button
          className="load-button"
          type="button"
          onClick={() => fileInput.current?.click()}
        >
          Load dataset
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.item(0);
            if (file) void loadFile(file);
            event.target.value = "";
          }}
        />
      </header>

      {state !== "ready" || !trace ? (
        <main
          className="welcome"
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
        >
          <section className="welcome-card">
            <div className="signal-mark" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </div>
            <p className="eyebrow">Long-duration scheduling traces</p>
            <h1>See who is driving every CPU, over time.</h1>
            <p>
              Open quantized JSON generated by the Python CLI. Data stays in
              your browser and can also be loaded by URL from a static
              deployment.
            </p>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={state === "loading"}
            >
              {state === "loading" ? "Loading…" : "Choose JSON dataset"}
            </button>
            <span>or drop it here</span>
            {state === "error" && (
              <div className="load-error" role="alert">
                {error}
              </div>
            )}
          </section>
        </main>
      ) : (
        <main className="dashboard">
          <section className="trace-heading">
            <div>
              <p className="eyebrow">{datasetName}</p>
              <h1>{trace.source.system || "Scheduling trace"}</h1>
              <p>{trace.source.date || "Quantized scheduling data"}</p>
            </div>
            <div className="trace-stats">
              <div>
                <span>Duration</span>
                <strong>{formatDuration(trace.trace.durationMs)}</strong>
              </div>
              <div>
                <span>Quantum</span>
                <strong>{formatDuration(trace.trace.quantumMs)}</strong>
              </div>
              <div>
                <span>CPUs</span>
                <strong>{trace.cpus.length}</strong>
              </div>
              <div>
                <span>Processes</span>
                <strong>{trace.processes.length}</strong>
              </div>
            </div>
          </section>

          <section className="timeline panel">
            <div className="section-heading timeline-heading">
              <div>
                <p className="eyebrow">Per-core utilisation</p>
                <h2>CPU timeline</h2>
              </div>
              <div className="timeline-controls">
                <span className="other-key">
                  <i />
                  Other (&lt; {trace.trace.squelchPercent}%)
                </span>
                <label>
                  <span>Bar width</span>
                  <input
                    type="range"
                    min="0"
                    max="1000"
                    value={zoomToSliderValue(
                      pixelsPerQuantum,
                      fitPixelsPerQuantum,
                    )}
                    disabled={fitPixelsPerQuantum >= MAX_PIXELS_PER_QUANTUM}
                    aria-label="Timeline zoom"
                    onChange={(event) =>
                      setPixelsPerQuantum(
                        sliderValueToZoom(
                          Number(event.target.value),
                          fitPixelsPerQuantum,
                        ),
                      )
                    }
                  />
                  <output>
                    {Math.abs(pixelsPerQuantum - fitPixelsPerQuantum) < 0.001
                      ? "Fit"
                      : `${pixelsPerQuantum.toFixed(pixelsPerQuantum < 10 ? 1 : 0)} px`}
                  </output>
                </label>
                <span className="zoom-hint">W/S zoom · A/D pan · ⌘ scroll</span>
              </div>
            </div>
            <CpuChart
              cpus={trace.cpus}
              processes={trace.processes}
              eventGroups={trace.events}
              quantumCount={trace.trace.quantumCount}
              quantumMs={trace.trace.quantumMs}
              pixelsPerQuantum={pixelsPerQuantum}
              minPixelsPerQuantum={fitPixelsPerQuantum}
              maxPixelsPerQuantum={MAX_PIXELS_PER_QUANTUM}
              onPixelsPerQuantumChange={setPixelsPerQuantum}
              onFitPixelsPerQuantumChange={handleFitWidthChange}
              selectedProcess={selectedProcess}
              onSelectProcess={setSelectedProcess}
            />
            <p className="chart-note">
              Each narrow bar is one quantum; its height is total CPU use. Click
              a colored segment or process row to isolate that process.
            </p>
          </section>

          <ProcessTable
            processes={trace.processes}
            quantumMs={trace.trace.quantumMs}
            selectedProcess={selectedProcess}
            onSelectProcess={setSelectedProcess}
          />
        </main>
      )}
    </div>
  );
}
