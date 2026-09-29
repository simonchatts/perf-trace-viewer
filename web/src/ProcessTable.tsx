/* Render sortable process metadata and detailed per-thread CPU totals. */

import { useMemo, useState } from "react";

import { formatDuration, formatQuantum, processColor } from "./format";
import type { TraceProcess } from "./types";

type SortKey = "cpuMs" | "firstQuantum" | "lastQuantum";

interface ProcessTableProps {
  colorHashSeed: number;
  processes: TraceProcess[];
  quantumMs: number;
  selectedProcess: number | null;
  onSelectProcess: (index: number | null) => void;
}

export function ProcessTable({
  colorHashSeed,
  processes,
  quantumMs,
  selectedProcess,
  onSelectProcess,
}: ProcessTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("cpuMs");
  const [ascending, setAscending] = useState(false);
  const [filter, setFilter] = useState("");
  const selected = selectedProcess === null ? null : processes[selectedProcess];
  const rows = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    return processes
      .map((process, index) => ({ process, index }))
      .filter(({ process }) =>
        `${process.name} ${process.pid ?? "kernel"}`
          .toLocaleLowerCase()
          .includes(needle),
      )
      .sort((left, right) => {
        const difference = left.process[sortKey] - right.process[sortKey];
        return (
          (ascending ? difference : -difference) ||
          left.process.name.localeCompare(right.process.name)
        );
      });
  }, [ascending, filter, processes, sortKey]);

  // Select a new sort or reverse the current column's direction.
  function sortBy(key: SortKey) {
    if (key === sortKey) setAscending((value) => !value);
    else {
      setSortKey(key);
      setAscending(key !== "cpuMs");
    }
  }

  // Label a sortable column with its current direction.
  function sortLabel(label: string, key: SortKey): string {
    if (key !== sortKey) return label;
    return `${label} ${ascending ? "↑" : "↓"}`;
  }

  return (
    <section className="process-section panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Process index</p>
          <h2>Visible contributors</h2>
        </div>
        <label className="search-field">
          <span>Filter</span>
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Name or PID"
          />
        </label>
      </div>

      {selected && (
        <div className="process-detail">
          <div className="detail-title">
            <i
              style={{ background: processColor(selected.name, colorHashSeed) }}
            />
            <div>
              <strong>{selected.name}</strong>
              <span>
                {selected.pid === null
                  ? "Kernel and unresolved work"
                  : `PID ${selected.pid}`}
              </span>
            </div>
            <button type="button" onClick={() => onSelectProcess(null)}>
              Clear highlight
            </button>
          </div>
          {(selected.comm ||
            selected.executable ||
            selected.commandLine?.length) && (
            <dl className="process-attributes">
              {selected.comm && (
                <>
                  <dt>Kernel name</dt>
                  <dd>{selected.comm}</dd>
                </>
              )}
              {selected.executable && (
                <>
                  <dt>Executable</dt>
                  <dd title={selected.executable}>{selected.executable}</dd>
                </>
              )}
              {selected.commandLine?.length ? (
                <>
                  <dt>Command line</dt>
                  <dd title={selected.commandLine.join(" ")}>
                    {selected.commandLine.join(" ")}
                  </dd>
                </>
              ) : null}
            </dl>
          )}
          <div
            className="thread-list"
            role="table"
            aria-label={`${selected.name} threads`}
          >
            <div className="thread-row thread-header" role="row">
              <span>Thread</span>
              <span>TID</span>
              <span>CPU time</span>
            </div>
            {selected.threads.map((thread) => (
              <div className="thread-row" role="row" key={thread.id}>
                <span title={thread.name}>{thread.name}</span>
                <span className="numeric">{thread.tid}</span>
                <span className="numeric">{formatDuration(thread.cpuMs)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Process</th>
              <th>PID</th>
              <th>
                <button onClick={() => sortBy("cpuMs")}>
                  {sortLabel("CPU time", "cpuMs")}
                </button>
              </th>
              <th>
                <button onClick={() => sortBy("firstQuantum")}>
                  {sortLabel("First", "firstQuantum")}
                </button>
              </th>
              <th>
                <button onClick={() => sortBy("lastQuantum")}>
                  {sortLabel("Last", "lastQuantum")}
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ process, index }) => (
              <tr
                key={process.id}
                className={selectedProcess === index ? "selected" : ""}
                onClick={() =>
                  onSelectProcess(selectedProcess === index ? null : index)
                }
              >
                <td>
                  <i
                    className="process-swatch"
                    style={{
                      background: processColor(process.name, colorHashSeed),
                    }}
                  />
                  <strong>{process.name}</strong>
                </td>
                <td className="numeric">{process.pid ?? "—"}</td>
                <td className="numeric">{formatDuration(process.cpuMs)}</td>
                <td className="numeric">
                  {formatQuantum(process.firstQuantum, quantumMs)}
                </td>
                <td className="numeric">
                  {formatQuantum(process.lastQuantum, quantumMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="table-note">
        Only processes meeting the per-quantum squelch threshold appear here.
        CPU totals include all of their scheduled time.
      </p>
    </section>
  );
}
