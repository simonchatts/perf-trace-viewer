/* Load quantized datasets and compose the interactive scheduling dashboard. */

import {
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { CpuChart } from "./CpuChart";
import { COLOR_HASH_SEED, formatDuration, validateTrace } from "./format";
import { ProcessTable } from "./ProcessTable";
import {
  checkPluginSyntax,
  compilePlugin,
  PLUGIN_EXAMPLE,
  PLUGIN_STORAGE_KEY,
  transformSdtEvents,
} from "./sdtPlugin";
import type { QuantizedTrace } from "./types";

type LoadState = "empty" | "loading" | "ready" | "error";

const MAX_PIXELS_PER_QUANTUM = 100;

// Read the browser-local plugin without making unavailable storage fatal.
function storedPlugin(): string | null {
  try {
    return window.localStorage.getItem(PLUGIN_STORAGE_KEY);
  } catch {
    return null;
  }
}

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
  const [zoomLimitReached, setZoomLimitReached] = useState(false);
  const [fitPixelsPerQuantum, setFitPixelsPerQuantum] = useState(1);
  const [pixelsPerQuantum, setPixelsPerQuantum] = useState(1);
  const [colorHashSeed, setColorHashSeed] = useState(COLOR_HASH_SEED);
  const [showColorHashSeed, setShowColorHashSeed] = useState(false);
  const [localPlugin, setLocalPlugin] = useState(storedPlugin);
  const [pagePlugin, setPagePlugin] = useState<string | null>(null);
  const [pagePluginError, setPagePluginError] = useState("");
  const [pluginSource, setPluginSource] = useState(localPlugin ?? "");
  const [pluginDraft, setPluginDraft] = useState("");
  const [pluginOpen, setPluginOpen] = useState(false);
  const [pluginError, setPluginError] = useState("");
  const previousFitWidth = useRef<number | null>(null);
  const seedLabelTimeout = useRef<number | null>(null);
  const pluginView = useMemo(() => {
    if (!trace) return { events: [], error: "" };
    try {
      return {
        events: transformSdtEvents(trace, compilePlugin(pluginSource)),
        error: "",
      };
    } catch (reason) {
      return {
        events: trace.events,
        error: reason instanceof Error ? reason.message : String(reason),
      };
    }
  }, [pluginSource, trace]);

  // Open a fresh edit buffer so Cancel never changes the active plugin.
  function openPluginEditor() {
    setPluginDraft(pluginSource);
    setPluginError("");
    setPluginOpen(true);
  }

  // Validate code and loaded events before persisting and closing the editor.
  function savePlugin() {
    try {
      const rules = compilePlugin(pluginDraft);
      if (trace) transformSdtEvents(trace, rules);
      window.localStorage.setItem(PLUGIN_STORAGE_KEY, pluginDraft);
      setLocalPlugin(pluginDraft);
      setPluginSource(pluginDraft);
      setPluginError("");
      setPluginOpen(false);
    } catch (reason) {
      setPluginError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  // Clear the seed label timer if the app unmounts during its display period.
  useEffect(
    () => () => {
      if (seedLabelTimeout.current !== null) {
        window.clearTimeout(seedLabelTimeout.current);
      }
    },
    [],
  );

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

  // Load the page-specified plugin as the active source when ?sdt= is present.
  useEffect(() => {
    const pluginUrl = new URLSearchParams(window.location.search).get("sdt");
    if (!pluginUrl) return;
    const controller = new AbortController();
    fetch(pluginUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok)
          throw new Error(`Plugin request failed (${response.status}).`);
        return response.text();
      })
      .then((source) => {
        compilePlugin(source);
        setPagePlugin(source);
        setPluginSource(source);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setPagePluginError(
          reason instanceof Error ? reason.message : String(reason),
        );
      });
    return () => controller.abort();
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

  // Move through unsigned 32-bit seeds and briefly reveal the new value.
  function changeColorHashSeed(delta: -1 | 1) {
    setColorHashSeed((current) => (current + delta) >>> 0);
    setShowColorHashSeed(true);
    if (seedLabelTimeout.current !== null) {
      window.clearTimeout(seedLabelTimeout.current);
    }
    seedLabelTimeout.current = window.setTimeout(() => {
      setShowColorHashSeed(false);
      seedLabelTimeout.current = null;
    }, 3000);
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
        <div className="header-actions">
          <output
            className={`seed-value${showColorHashSeed ? " visible" : ""}`}
            aria-live="polite"
          >
            Colour seed {colorHashSeed}
          </output>
          <div className="seed-buttons" aria-label="Colour seed">
            <button
              type="button"
              aria-label="Decrease colour seed"
              title="Decrease colour seed"
              onClick={() => changeColorHashSeed(-1)}
            >
              ‹
            </button>
            <button
              type="button"
              aria-label="Increase colour seed"
              title="Increase colour seed"
              onClick={() => changeColorHashSeed(1)}
            >
              ›
            </button>
          </div>
          <button
            className="plugin-button"
            type="button"
            onClick={openPluginEditor}
          >
            SDT plugin
          </button>
          <button
            className="load-button"
            type="button"
            onClick={() => fileInput.current?.click()}
          >
            Load dataset
          </button>
        </div>
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

      {pluginView.error && (
        <div className="plugin-runtime-error" role="alert">
          SDT plugin: {pluginView.error}{" "}
          <button type="button" onClick={openPluginEditor}>
            Edit plugin
          </button>
        </div>
      )}

      {pagePluginError && (
        <div className="plugin-runtime-error" role="alert">
          SDT plugin URL: {pagePluginError}
        </div>
      )}

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
              <h1>
                {trace.source.title ||
                  trace.source.system ||
                  "Scheduling trace"}
              </h1>
              <div className="trace-meta">
                <p>{trace.source.date || "Quantized scheduling data"}</p>
                {trace.source.title && trace.source.system && (
                  <p>{trace.source.system}</p>
                )}
              </div>
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
                    aria-label="Timeline zoom"
                    onChange={(event) => {
                      if (fitPixelsPerQuantum >= MAX_PIXELS_PER_QUANTUM) {
                        setZoomLimitReached(true);
                      } else {
                        setPixelsPerQuantum(
                          sliderValueToZoom(
                            Number(event.target.value),
                            fitPixelsPerQuantum,
                          ),
                        );
                      }
                    }}
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
              colorHashSeed={colorHashSeed}
              cpus={trace.cpus}
              processes={trace.processes}
              eventGroups={pluginView.events}
              quantumCount={trace.trace.quantumCount}
              quantumMs={trace.trace.quantumMs}
              pixelsPerQuantum={pixelsPerQuantum}
              minPixelsPerQuantum={fitPixelsPerQuantum}
              maxPixelsPerQuantum={MAX_PIXELS_PER_QUANTUM}
              onPixelsPerQuantumChange={setPixelsPerQuantum}
              onFitPixelsPerQuantumChange={handleFitWidthChange}
              onZoomLimitReached={() => setZoomLimitReached(true)}
              selectedProcess={selectedProcess}
              onSelectProcess={setSelectedProcess}
            />
            <p className="chart-note">
              Each narrow bar is one quantum; its height is total CPU use. Click
              a colored segment or process row to isolate that process.
            </p>
          </section>

          <ProcessTable
            colorHashSeed={colorHashSeed}
            processes={trace.processes}
            pidTable={trace.pidTable}
            quantumMs={trace.trace.quantumMs}
            selectedProcess={selectedProcess}
            onSelectProcess={setSelectedProcess}
          />
        </main>
      )}
      {pluginOpen && (
        <div className="dialog-backdrop">
          <section
            className="plugin-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="plugin-title"
          >
            <h2 id="plugin-title">SDT event plugin</h2>
            <p>
              Enter a JavaScript array of rules. Category and name use full
              globs (* and ?). Rules run in order; return null to try the next
              rule. A result needs a category and display label.
              <code>context.lookupPid(pid)</code> returns all matching processes
              as an array of id, pid, and name objects.
            </p>
            <textarea
              aria-label="Plugin JavaScript"
              value={pluginDraft}
              placeholder={PLUGIN_EXAMPLE}
              spellCheck={false}
              onChange={(event) => {
                const source = event.target.value;
                setPluginDraft(source);
                try {
                  checkPluginSyntax(source);
                  setPluginError("");
                } catch (reason) {
                  setPluginError(
                    reason instanceof Error ? reason.message : String(reason),
                  );
                }
              }}
            />
            {pluginError && (
              <p className="plugin-error" role="alert">
                {pluginError}
              </p>
            )}
            <div className="plugin-actions">
              <button
                type="button"
                onClick={() => {
                  setPluginDraft(PLUGIN_EXAMPLE);
                  setPluginError("");
                }}
              >
                Insert example
              </button>
              {pagePlugin !== null && (
                <button
                  type="button"
                  onClick={() => {
                    setPluginDraft(pagePlugin);
                    setPluginError("");
                  }}
                >
                  Insert page version
                </button>
              )}
              {localPlugin !== null && (
                <button
                  type="button"
                  onClick={() => {
                    setPluginDraft(localPlugin);
                    setPluginError("");
                  }}
                >
                  Insert local version
                </button>
              )}
              <button type="button" onClick={() => setPluginOpen(false)}>
                Cancel
              </button>
              <button type="button" onClick={savePlugin}>
                Save locally
              </button>
            </div>
          </section>
        </div>
      )}
      {zoomLimitReached && (
        <div className="dialog-backdrop">
          <section
            className="zoom-limit-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="zoom-limit-title"
            aria-describedby="zoom-limit-description"
          >
            <h2 id="zoom-limit-title">Maximum zoom reached</h2>
            <p id="zoom-limit-description">
              This dataset is already at the maximum bar width, so it cannot be
              zoomed in any further.
            </p>
            <button type="button" onClick={() => setZoomLimitReached(false)}>
              OK
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
