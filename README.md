![CI](https://github.com/cisco-open/perf-trace-viewer/workflows/Main%20branch%20CI/badge.svg)

# Visualize thread scheduling data

This tool lets you visualize how a Linux system is scheduling threads over time:

![Screenshot](docs/.screenshot.png)

It uses one collection script (wrapping `perf sched record`) on the target
system, to record the data (eg for 10 seconds), and then a second script to
convert this into either detailed Trace Event format or a compact, aggregated
format for the bundled web viewer. The aggregation format is intended for much
longer recordings where individual scheduling events are too detailed to be
useful.

The collection script requires Bash and should work on Linux systems supporting
`perf`. The conversion script requires Python 3.10 or later.

## Usage

The tool has a three step workflow:

![Workflow](docs/.workflow.png)

 - On the [most recent
   release](https://github.com/cisco-open/perf-trace-viewer/releases), download
   the two files `collect` and `perf_trace_viewer`,  and make both files
   executable (`chmod +x`).

 - On the target linux system, run the `collect` script. eg for 5 seconds of
   data, run `sudo ./collect 5`.

 - This produces a `perf-data-<datestamp>-<timestamp>.tar.xz` file or similar
   (depending on which compression options are available on the target system),
   that should be copied off, and processed using the `perf_trace_viewer`
   script. This requires Python 3.10 or later. For example, `./perf_trace_viewer
   <input file> <output file>`.

 - Visualize the data. eg in Chrome, open `chrome://tracing` and load the output
   file you just converted.

## Aggregated viewer for long traces

Use `--aggregate` to aggregate scheduling into 200 ms intervals, with small
per-process contributions folded into an `other` segment:

    ./perf_trace_viewer --aggregate input.tar.xz trace.aggregated.json

Set an optional main heading for the web viewer with `--title`; the system
description remains visible as secondary metadata:

    ./perf_trace_viewer --aggregate --title "Load test: build 42" \
      input.tar.xz trace.aggregated.json

The default aggregation interval is 200 ms and the minimum contribution
threshold is 1%. Both are configurable. For example, this keeps contributions of at least
2.5%:

    ./perf_trace_viewer --aggregate --agg-time 0.2 --agg-min-percent 2.5 \
      input.tar.xz trace.aggregated.json

Collected archives may be plain or compressed tar files. The perf script member
may also be gzip-compressed as `perf.data.txt.gz`; both forms are read
transparently.

Aggregation mode streams the source and skips wakeup, waiting-track,
runtime-accounting, and detailed Trace Event construction work that the browser
does not need. It retains only lightweight fork/exit identity bookkeeping and
reads runtime records only for namespace-aware PID mapping. Its output is a
sparse JSON object using the versioned
`perf-trace-viewer.quantized/v1` schema. Each CPU contains only non-empty
aggregation intervals, whose stack entries reference the top-level process array by index;
index `-1` is the `other` bucket. The process metadata includes all known
threads and their CPU-time totals. See the
[aggregation format documentation](docs/quantized-format.md) for the complete
contract.

To run the viewer during development:

    npm install
    npm run dev

For a portable local server, download `perf_trace_ui` from the release and make
it executable (`chmod +x perf_trace_ui`). It contains the compiled UI and its
Python 3 server (no extra Python packages required):

    ./perf_trace_ui

Then open <http://127.0.0.1:8000/>. You can choose another listening address
and port with `./perf_trace_ui --host 0.0.0.0 --port 9000`. It can also be run
with `python3 perf_trace_ui` if executable permissions were not preserved.

Load a local JSON file with the file picker. A static deployment can keep the
application and datasets together; build with `npm run build`, copy a dataset
into `dist`, then link to it with a relative query parameter:

    https://example.net/perf/?data=trace.aggregated.json

Add an optional SDT plugin file with `sdt=`. The file must contain the same
JavaScript array expression accepted by the plugin editor. For example:

    https://example.net/perf/?data=trace.aggregated.json&sdt=rules.js

The URL plugin becomes active when loaded. In the editor, **Insert page
version** restores it, while **Insert local version** restores any plugin saved
in this browser. **Save locally** activates the edited plugin and stores it in
the browser; reloading a URL with `sdt=` loads the page version again.

To make a compact index for a directory of JSON files, place the built UI in
`dist/` beneath that directory and run `generate_index.py` from there. The
script creates `index.html` with a link for each JSON file, using its title,
date, and filename. If the directory has one `.js` file, each link also
passes it as `sdt=`. Use `--ui` and `--output` to choose other paths:

    /path/to/generate_index.py --ui dist/index.html --output traces.html

The **SDT plugin** button opens an editor for a JavaScript array of rules.
Each rule has `category` and `name` glob strings (`*` and `?`) and a
`transform(event, context)` callback. Rules are tried in order; return `null`
to leave an event unchanged and try the next rule, or return
`{ category: "new_category", label: "Display text" }` to change its tooltip
and marker colour category. `context.lookupPid(pid)` returns an array of all
known `{ id, pid, name }` matches, including reused PIDs. The code is stored
in the browser for the current origin, including across development-server
restarts on the same port. The editor checks syntax as you type and runs the
plugin against the loaded dataset before saving.

The production application shell is an installable offline-capable PWA. Trace
datasets are deliberately not added to its cache because they may be very
large and change independently of the viewer. For a static deployment, serve
hashed files below `assets/` with long-lived immutable caching, and serve
`index.html`, `sw.js`, and `manifest.webmanifest` with revalidation or a short
cache lifetime.

The `perf_trace_viewer` script is just a
[zipapp](https://docs.python.org/3/library/zipapp.html) (zipped set of `.py`
files that is executable on Linux, macOS and WSL) of the [perf_trace_viewer
source directory](perf_trace_viewer).

## FAQs

### Why does this tool exist?

There are [many existing
tools](https://profilerpedia.markhansen.co.nz/formats/linux-perf-sched/) that
transform the output of `perf sched record` into another format, but none that
let you visualize the output like this.

### What's so great about this sort of visualization?

If your performance bottleneck is just within a single process (eg a CPU-bound
computational task) then conventional profiling tools will help you. But when
the problem is system-wide (eg lots of small inefficient IPCs, or a particular
thread being starved due to some other high priority task) then there is no
substitute to being able to clearly see that.

### Can I customize what data is recorded?

The `collect` script can pass any arguments to `perf sched record` via `-o`. For
example, to record 10 seconds of data only on CPU cores 0, 2 and 3, you can run:

    ./collect -o "-C 0,2-3" 10

The collector can also augment the scheduling trace with application-specific events from userspace [SDT points](https://sourceware.org/systemtap/wiki/AddingUserSpaceProbingToApps), such as startup stages or configuration transitions.
Linux `perf` can expose these statically compiled markers as trace events using its [SDT support](https://lwn.net/Articles/570818/).

Pass each executable or shared library containing SDT points with `--sdt-object`.
The option may be repeated, and the collector discovers and records every SDT provider and probe embedded in the supplied objects:

    sudo ./collect \
      --sdt-object /opt/myapp/bin/controller \
      --sdt-object /opt/myapp/lib/libconfiguration.so \
      10

SDT discovery uses an isolated temporary `perf` build-ID cache.
By default, the collector creates that cache under `${TMPDIR:-/tmp}` and removes it when collection finishes.
Use the optional `--buildid-dir` argument when the cache should live on a different filesystem, for example when `/tmp` has limited space:

    sudo ./collect \
      --buildid-dir /var/tmp/perf-buildid \
      --sdt-object /opt/myapp/bin/controller \
      10

Both arguments are optional.
Without `--sdt-object`, the script skips SDT discovery and performs the normal scheduler-only collection.

### How do I resolve errors from the `collect` script?

If you get an error from `collect` like this:
```
ERROR: 'perf sched record --mmap-pages 8M  -- sleep 5' failed with exit code 129
```
then just try running the quoted command (`perf sched record --mmap-pages 8M
-- sleep 5` in this case) independently, and resolve any issues. For example:

 - Is the target system running Linux?
 - Is the `perf` command correctly installed?
 - Are you running with root privileges?

Once you can run the quoted command correctly, just run the `collect` script in
the same way.

### How do I navigate the Chrome Trace viewer?

A few tips to get started:

 - `?` shows all keyboard shortcuts.
 - `W`, `A`, `S`, `D` are invaluable for navigation.
 - Mouse/trackpad scrolling, with or without the alt/option key, is also useful.
 - `0` resets the timeline.
 - `4` lets you measure time easily. `1` restores the default selection
   behavior.

Processes are ordered with the most active at the top. You can expand/shrink the
view for every thread within a process using the triangle to the left of the
process name. There are also two pseudo-processes at the top:
 - The CPU process summarizes the scheduled work for each CPU core, and also has
   a special track showing any threads blocked for more than 3ms. (You can
   change this threshold via command-line options to `perf_trace_viewer`.)
- The kernel process summarizes kernel thread activity, including idle time.

### Why do some threads spill out across two rows?

Chrome Trace Viewer uses µs resolution, and the scheduling data uses ns
resolution (when supported by the version of perf). This disparity can mean
events that are close in time get spilled out into two rows by the Trace Viewer.
Ignore it.

### Why aren't you using Perfetto?

Perfetto is the replacement to Chrome Trace Viewer, and is where development
activity is. It also offers some useful capabilities, such as native support for
scheduling events, and a more performant binary data format.

Perfetto works fine with this tool, and you're welcome to use it if you prefer.
However, when this tool was started, Perfetto was less useful than classic Trace
Viewer for quickly analyzing the sort of big system for which this tool was
created, and we tend to find insights quicker using the classic tool. YMMV.

### Why do you need a big conversion script, when `perf script` exists?

[perf script](https://man7.org/linux/man-pages/man1/perf-script.1.html) makes it
easy to run a small Python script over a `perf.data` file. However, it is
inadquate for the task here. For example:

- The `perf script` does not provide access to the `PERF_RECORD_COMM` records
   providing the process/thread hierarchy at the start of a recording session,
   so we need to parse the more raw ascii output instead.

- If `perf sched record` is run in a pid namespace (as is typical for my use
  case), then the `PERF_RECORD_COMM` data is from outside the namespace, but
  the pids from the actual events are from within the namespace, so they don't
  match up. So the script here goes to some efforts to make sense of everything.

- `perf script` does not make it easy to do things like add the CPU/kernel
  pseudo-processes noted above.

### How do I make a new release?

 - Make any commits that are needed.
 - Tag the release commit (eg `git tag v1.0`)
 - Push it to GitHub (eg `git push origin main v1.0`)
 - If CI passes, then a release will be created with downloadable scripts
