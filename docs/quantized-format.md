# Quantized data format

Quantized output is a compact JSON object intended for long-duration scheduling
visualizations. Its schema identifier is
`perf-trace-viewer.quantized/v1`.

```json
{
  "schema": "perf-trace-viewer.quantized/v1",
  "trace": {
    "startTimeNs": "19443850798",
    "durationMs": 120005.607693,
    "quantumMs": 1000.0,
    "quantumCount": 121,
    "squelchPercent": 5.0,
    "cpuIds": [0, 1, 2, 3],
    "busyCpuMs": 199785.374278,
    "otherCpuMs": 61612.874146
  },
  "source": { "date": "...", "system": "..." },
  "processes": [
    {
      "id": "pid:123:0",
      "kind": "process",
      "pid": 123,
      "name": "example",
      "comm": "example-worker",
      "executable": "/usr/libexec/example",
      "commandLine": ["/usr/libexec/example", "--foreground"],
      "cpuMs": 1840.25,
      "firstQuantum": 2,
      "lastQuantum": 118,
      "threads": [
        { "id": "123:0", "tid": 123, "name": "example", "cpuMs": 1600.0 }
      ]
    }
  ],
  "cpus": [
    { "id": 0, "samples": [[2, [[0, 42.5], [-1, 3.1]]]] }
  ],
  "events": [
    {
      "quantum": 4,
      "events": [
        {
          "name": "band_begin",
          "args": { "arg1": 99900 },
          "timestampMs": 4900.0
        },
        {
          "name": "band_submitted",
          "args": { "arg1": 99900 },
          "timestampMs": 4950.0
        }
      ]
    },
    {
      "quantum": 7,
      "events": [{ "name": "boot_complete" }]
    }
  ]
}
```

`cpus[].samples` is sparse. Each sample is a pair of quantum index and stack
entries, and empty quanta are omitted. A stack entry is a process-array index
and floating-point CPU percentage. Index `-1` represents the combined `other`
bucket. The percentage denominator is one CPU's available time in that quantum;
the final partial quantum uses its actual duration.

Threads are combined before applying the threshold. A process is included in
`processes` only if its combined contribution meets or exceeds the squelch
percentage on at least one CPU in at least one quantum. Once included, its
`cpuMs` and thread totals cover all of its scheduled time, including
contributions hidden within `other`. `firstQuantum` and `lastQuantum` refer to
the first and last non-squelched samples visible in the chart.

Process and thread `id` values include an internal generation suffix. The
numeric `pid` and `tid` fields remain the user-visible Linux identifiers, while
the generation keeps a later reuse of the same number distinct in long traces.

When the input's `perf-mdata.txt` contains extended process information, a
non-kernel process can also contain:

- `comm`: the process name from `/proc/<pid>/stat`;
- `executable`: the full `/proc/<pid>/exe` target; and
- `commandLine`: the argument vector decoded from `/proc/<pid>/cmdline`.

These fields are optional because older recordings and processes that exit
during collection may not provide them. `name` remains the display name. The
producer prefers the basename of `executable`, then the basename of the first
command-line argument, then the name reported by perf, `comm`, and finally a
PID-derived fallback.

The `kernel` process entry has a null PID and combines kernel threads plus work
whose namespace-aware process identity could not be resolved, matching the
detailed viewer's pseudo-process behavior.

`events` contains `sdt_*` markers, grouped by containing quantum. The group
`category` identifies the SDT provider, for example `sdt_processmgr` or
`sdt_cfgmgr`. `quantum` is a zero-based index relative to `trace.startTimeNs`; the UI
draws the marker at that quantum's left boundary. Each event's `timestampMs` is
its actual offset from `trace.startTimeNs`, allowing the UI to show the event's
timestamp rather than the containing quantum range. For example, an event 4.9
seconds after the trace start belongs to quantum 4 when `quantumMs` is 1000 and
is drawn at the start of the 4–5 second interval. Multiple markers in the same
quantum and category appear together in the nested `events` array.

Events carry the probe name. If present, the producer also emits the probe's
integer arguments in the named `args` object, including all arguments from
`arg1` onward; events without arguments omit that field. The producer always
emits the top-level `events` array, which is empty when the input contains no
supported markers. Consumers should also accept older v1 data in which the
`events` or `args` field is absent and may contain the legacy top-level `arg1`
field.

`startTimeNs` is a string so consumers do not lose precision in JavaScript.
Other times are offsets or durations and are safe JSON numbers. Older v1 event
records may omit `timestampMs`; consumers should fall back to the containing
quantum's start when reading them.
