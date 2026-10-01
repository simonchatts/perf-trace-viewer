# Copyright 2024 Cisco Systems, Inc. and its affiliates
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# SPDX-License-Identifier: Apache-2.0

# This module streams perf scheduling records into sparse, fixed-duration CPU
# utilisation samples for the bundled web viewer.

from collections import defaultdict
from posixpath import basename
from typing import (
    Callable,
    DefaultDict,
    Dict,
    Iterable,
    List,
    Mapping,
    Optional,
    Tuple,
    cast,
)

from parse_mdata import ProcStat
from parse_perf_script import (
    CommRecord,
    ExitRecord,
    ForkRecord,
    SchedRecord,
    SdtRecord,
    parse,
)

NANOSECONDS_PER_SECOND = 1_000_000_000
NANOSECONDS_PER_MILLISECOND = 1_000_000
OTHER_PROCESS_INDEX = -1
SCHEMA = "perf-trace-viewer.quantized/v1"

ThreadKey = Tuple[int, int]
ProcessKey = Tuple[str, int, int]
RawCell = DefaultDict[ThreadKey, int]
RawQuanta = DefaultDict[int, RawCell]
RawCpus = DefaultDict[int, RawQuanta]
ProcessCell = DefaultDict[ProcessKey, int]
ProcessQuanta = DefaultDict[int, ProcessCell]
ProcessCpus = DefaultDict[int, ProcessQuanta]


# Process perf data with the low-memory quantized engine.
def process_quantized_perf_data(
    lines: Iterable[str],
    mdata: Dict[str, str],
    proc_info: Dict[int, ProcStat],
    skip: float,
    duration: float,
    quantum: float,
    squelch: float,
) -> Mapping[str, object]:
    quantum_ns = int(quantum * NANOSECONDS_PER_SECOND)

    # Determine kernel threads in the same way as the detailed trace engine.
    def is_kernel(pid: int) -> bool:
        try:
            pf_kthread = 0x00200000  # from linux/sched.h
            return bool(proc_info[pid].flags & pf_kthread)
        except KeyError:
            return False

    engine = QuantizedEngine(
        skip_ns=int(skip * NANOSECONDS_PER_SECOND),
        duration_ns=int(duration * NANOSECONDS_PER_SECOND),
        quantum_ns=quantum_ns,
        squelch=squelch,
        is_kernel=is_kernel,
        proc_info=proc_info,
        source_metadata=mdata,
    )
    return engine.process(lines)


class QuantizedEngine:
    """Accumulate scheduled intervals without constructing detailed trace events."""

    def __init__(
        self,
        skip_ns: int,
        duration_ns: int,
        quantum_ns: int,
        squelch: float,
        is_kernel: Callable[[int], bool],
        proc_info: Dict[int, ProcStat],
        source_metadata: Mapping[str, str],
    ) -> None:
        self.skip_ns = skip_ns
        self.duration_ns = duration_ns
        self.quantum_ns = quantum_ns
        self.squelch = squelch
        self.is_kernel = is_kernel
        self.proc_info = proc_info
        self.source_metadata = dict(source_metadata)
        self.process_names: Dict[ProcessKey, str] = {}
        self.public_generations: Dict[int, int] = {}
        self.thread_names: Dict[Tuple[ProcessKey, int], str] = {}
        self.internal_names: Dict[ThreadKey, str] = {}
        self.thread_mappings: Dict[ThreadKey, Tuple[ProcessKey, int]] = {}
        self.backup_mappings: Dict[ThreadKey, Tuple[ProcessKey, int]] = {}
        self.thread_process_tokens: Dict[ThreadKey, ThreadKey] = {}
        self.thread_generations: Dict[int, int] = {}
        self.active_threads: set[int] = set()
        self.cpu_running: Dict[int, Tuple[ThreadKey, int]] = {}
        self.raw_cpus: RawCpus = defaultdict(
            lambda: defaultdict(lambda: defaultdict(int))
        )
        self.sdt_events: List[SdtRecord] = []
        self.trace_start_ts: Optional[int] = None
        self.last_ts: Optional[int] = None

    # Consume the input stream and return a serializable sparse dataset.
    def process(self, lines: Iterable[str]) -> Mapping[str, object]:
        for line in lines:
            # Quantized mode skips wakeups and records used only by detailed
            # Trace Events. Forks/exits are retained solely to identify PID reuse.
            if not any(
                marker in line
                for marker in (
                    "sched_switch:",
                    "sched_stat_runtime:",
                    "PERF_RECORD_COMM",
                    "PERF_RECORD_FORK",
                    "PERF_RECORD_EXIT",
                    "sdt_",
                )
            ):
                continue
            record = parse(line)
            if isinstance(record, CommRecord):
                self.add_comm(record)
            elif isinstance(record, ForkRecord):
                self.add_fork(record)
            elif isinstance(record, ExitRecord):
                self.add_exit(record)
            elif isinstance(record, SdtRecord):
                self.sdt_events.append(record)
            elif isinstance(record, SchedRecord):
                self.observe_timestamp(record.ts)
                if record.rec_type == "sched_switch":
                    self.sched_switch(record)
                elif record.rec_type == "sched_stat_runtime":
                    self.add_runtime_mapping(record)

        return self.finish()

    # Remember process and thread names emitted by perf.
    def add_comm(self, record: CommRecord) -> None:
        generation = max(
            self.public_generations.get(record.pid, 0),
            self.thread_generations.get(record.pid, 0),
        )
        process_key = ("process", record.pid, generation)
        self.thread_names[(process_key, record.tid)] = record.name
        if record.pid == record.tid:
            self.process_names[process_key] = record.name

    # Start a scheduler-thread generation and associate it with its process token.
    def add_fork(self, record: ForkRecord) -> None:
        self.observe_timestamp(record.ts, can_start=False)
        thread_key = self.begin_thread(record.tid)
        process_token = (
            thread_key if record.pid == record.tid else self.current_thread(record.pid)
        )
        self.thread_process_tokens[thread_key] = process_token

    # Mark a thread inactive so a reused numeric PID receives a fresh identity.
    def add_exit(self, record: ExitRecord) -> None:
        self.observe_timestamp(record.ts, can_start=False)
        self.active_threads.discard(record.tid)

    # Return the active scheduler-thread identity, creating one when necessary.
    def current_thread(self, ipid: int) -> ThreadKey:
        if ipid == 0:
            return (0, 0)
        if ipid not in self.active_threads:
            generation = self.thread_generations.get(ipid, -1) + 1
            self.thread_generations[ipid] = generation
            self.active_threads.add(ipid)
        return (ipid, self.thread_generations[ipid])

    # Start a generation explicitly in response to a fork record.
    def begin_thread(self, ipid: int) -> ThreadKey:
        self.active_threads.discard(ipid)
        return self.current_thread(ipid)

    # Associate a scheduler thread with a stable public process instance.
    def map_thread(self, thread_key: ThreadKey, pid: int, tid: int) -> None:
        if pid == 0:
            return
        process_token = self.thread_process_tokens.get(thread_key)
        generation = process_token[1] if process_token is not None else 0
        proposed_process = ("process", pid, generation)
        process_key, tid = self.thread_mappings.setdefault(
            thread_key, (proposed_process, tid)
        )
        pid = process_key[1]
        generation = process_key[2]
        self.public_generations[pid] = max(
            generation, self.public_generations.get(pid, 0)
        )
        name = self.internal_names.get(thread_key)
        if name is not None:
            self.thread_names.setdefault((process_key, tid), name)
            if pid == tid:
                self.process_names.setdefault(process_key, name)

    # Establish the trace time origin and latest useful scheduling timestamp.
    def observe_timestamp(self, ts: int, can_start: bool = True) -> None:
        if ts <= 0:
            return
        if self.trace_start_ts is None:
            if not can_start:
                return
            self.trace_start_ts = ts
        self.last_ts = ts if self.last_ts is None else max(self.last_ts, ts)

    # Use runtime records only to resolve namespace-aware process/thread IDs.
    def add_runtime_mapping(self, record: SchedRecord) -> None:
        try:
            ipid = int(record.args["pid"])
        except (KeyError, ValueError):
            return
        self.map_thread(self.current_thread(ipid), record.opid, record.otid)

    # Close one scheduled interval and remember which thread now owns the CPU.
    def sched_switch(self, record: SchedRecord) -> None:
        try:
            prev_pid = int(record.args["prev_pid"])
            next_pid = int(record.args["next_pid"])
            prev_comm = record.args["prev_comm"]
            next_comm = record.args["next_comm"]
        except (KeyError, ValueError):
            return

        previous = self.cpu_running.get(record.cpu)
        if previous is None:
            # The first switch tells us what was running from the start of the
            # trace up to this point, even though its actual start preceded it.
            assert self.trace_start_ts is not None
            interval_thread = self.current_thread(prev_pid)
            interval_start = self.trace_start_ts
        else:
            interval_thread, interval_start = previous
        next_thread = self.current_thread(next_pid)
        self.internal_names[interval_thread] = prev_comm
        self.internal_names[next_thread] = next_comm

        # The record header identifies the outgoing task in normal perf output.
        # Keep it as a fallback because runtime records are more authoritative.
        if prev_pid != 0 and not self.is_kernel(prev_pid) and record.opid != 0:
            process_token = self.thread_process_tokens.get(interval_thread)
            generation = process_token[1] if process_token is not None else 0
            self.backup_mappings[interval_thread] = (
                ("process", record.opid, generation),
                record.otid,
            )
        self.add_interval(record.cpu, interval_thread, interval_start, record.ts)
        self.cpu_running[record.cpu] = (next_thread, record.ts)

    # Split one scheduled interval at quantum boundaries and clip it to the window.
    def add_interval(
        self, cpu: int, thread_key: ThreadKey, start: int, end: int
    ) -> None:
        if thread_key[0] == 0 or self.trace_start_ts is None:
            return
        window_start = self.trace_start_ts + self.skip_ns
        window_end = window_start + self.duration_ns if self.duration_ns else end
        clipped_start = max(start, window_start)
        clipped_end = min(end, window_end)
        if clipped_start >= clipped_end:
            return

        cursor = clipped_start
        while cursor < clipped_end:
            quantum_index = (cursor - window_start) // self.quantum_ns
            quantum_end = window_start + (quantum_index + 1) * self.quantum_ns
            part_end = min(clipped_end, quantum_end)
            self.raw_cpus[cpu][quantum_index][thread_key] += part_end - cursor
            cursor = part_end

    # Close open CPU intervals, resolve IDs, apply squelching, and encode output.
    def finish(self) -> Mapping[str, object]:
        if self.trace_start_ts is None or self.last_ts is None:
            return self.empty_result()

        window_start = self.trace_start_ts + self.skip_ns
        available_end = max(window_start, self.last_ts)
        window_end = (
            min(available_end, window_start + self.duration_ns)
            if self.duration_ns
            else available_end
        )
        for cpu, (thread_key, started) in self.cpu_running.items():
            self.add_interval(cpu, thread_key, started, window_end)

        for thread_key, mapping in self.backup_mappings.items():
            if thread_key not in self.thread_mappings:
                self.thread_mappings[thread_key] = mapping
                process_key, tid = mapping
                name = self.internal_names.get(thread_key)
                if name is not None:
                    self.thread_names.setdefault((process_key, tid), name)
                    if process_key[1] == tid:
                        self.process_names.setdefault(process_key, name)

        duration_ns = max(0, window_end - window_start)
        quantum_count = (
            (duration_ns + self.quantum_ns - 1) // self.quantum_ns if duration_ns else 0
        )
        process_cpus, process_totals, thread_totals = self.resolve_processes()
        visible, first_last = self.find_visible_processes(
            process_cpus, duration_ns, quantum_count
        )
        process_keys = sorted(
            visible,
            key=lambda key: (-process_totals[key], key[0], key[1], key[2]),
        )
        process_indexes = {key: index for index, key in enumerate(process_keys)}
        processes = [
            self.encode_process(
                key,
                process_totals[key],
                thread_totals.get(key, {}),
                first_last[key],
            )
            for key in process_keys
        ]
        # Keep a separate complete PID index while preserving visible process
        # indexes used by the compact CPU samples.
        all_keys = (
            set(process_totals)
            | set(self.process_names)
            | {key for key, _tid in self.thread_names}
        )
        all_keys.update(
            ("process", pid, self.public_generations.get(pid, 0))
            for pid in self.proc_info
        )
        observed_quanta: Dict[ProcessKey, Tuple[int, int]] = {}
        for quanta in process_cpus.values():
            for quantum_index, cell in quanta.items():
                for key in cell:
                    first, last = observed_quanta.get(
                        key, (quantum_index, quantum_index)
                    )
                    observed_quanta[key] = (
                        min(first, quantum_index),
                        max(last, quantum_index),
                    )
        pid_table: List[Dict[str, object]] = []
        for key in sorted(all_keys, key=lambda item: (item[0], item[1], item[2])):
            entry = dict(
                self.encode_process(
                    key,
                    process_totals.get(key, 0),
                    thread_totals.get(key, {}),
                    observed_quanta.get(key),
                )
            )
            entry["visibleProcessIndex"] = process_indexes.get(key)
            pid_table.append(entry)
        cpus, other_ns = self.encode_cpus(
            process_cpus,
            process_indexes,
            duration_ns,
            quantum_count,
        )

        return {
            "schema": SCHEMA,
            "trace": {
                "startTimeNs": str(window_start),
                "durationMs": round(duration_ns / NANOSECONDS_PER_MILLISECOND, 6),
                "quantumMs": round(self.quantum_ns / NANOSECONDS_PER_MILLISECOND, 6),
                "quantumCount": quantum_count,
                "squelchPercent": self.squelch,
                "cpuIds": sorted(self.raw_cpus),
                "busyCpuMs": round(
                    sum(process_totals.values()) / NANOSECONDS_PER_MILLISECOND, 6
                ),
                "otherCpuMs": round(other_ns / NANOSECONDS_PER_MILLISECOND, 6),
            },
            "source": self.source_metadata,
            "processes": processes,
            "pidTable": pid_table,
            "cpus": cpus,
            "events": self.encode_sdt_events(window_start, window_end),
        }

    # Group SDT markers by provider and quantum so categories do not bleed together.
    def encode_sdt_events(
        self, window_start: int, window_end: int
    ) -> List[Mapping[str, object]]:
        grouped: DefaultDict[Tuple[str, int], List[Mapping[str, object]]] = defaultdict(
            list
        )
        for event in self.sdt_events:
            if event.ts < window_start or event.ts >= window_end:
                continue
            quantum = (event.ts - window_start) // self.quantum_ns
            encoded: Dict[str, object] = {
                "name": event.name,
                "timestampMs": round(
                    (event.ts - window_start) / NANOSECONDS_PER_MILLISECOND, 6
                ),
            }
            if event.args:
                encoded["args"] = event.args
            grouped[(event.category, quantum)].append(encoded)
        return [
            {
                "quantum": quantum,
                "category": category,
                "events": grouped[(category, quantum)],
            }
            for category, quantum in sorted(grouped, key=lambda key: (key[1], key[0]))
        ]

    # Resolve internal scheduler PIDs and aggregate threads into processes.
    def resolve_processes(
        self,
    ) -> Tuple[
        ProcessCpus,
        DefaultDict[ProcessKey, int],
        DefaultDict[ProcessKey, DefaultDict[ThreadKey, int]],
    ]:
        process_cpus: ProcessCpus = defaultdict(
            lambda: defaultdict(lambda: defaultdict(int))
        )
        process_totals: DefaultDict[ProcessKey, int] = defaultdict(int)
        thread_totals: DefaultDict[ProcessKey, DefaultDict[ThreadKey, int]] = (
            defaultdict(lambda: defaultdict(int))
        )
        for cpu, quanta in self.raw_cpus.items():
            for quantum_index, cell in quanta.items():
                for thread_key, runtime_ns in cell.items():
                    key, _tid = self.resolve_process(thread_key)
                    process_cpus[cpu][quantum_index][key] += runtime_ns
                    process_totals[key] += runtime_ns
                    thread_totals[key][thread_key] += runtime_ns
        return process_cpus, process_totals, thread_totals

    # Resolve one scheduler PID, grouping kernel and unknown work consistently.
    def resolve_process(self, thread_key: ThreadKey) -> Tuple[ProcessKey, int]:
        ipid = thread_key[0]
        if self.is_kernel(ipid):
            return ("kernel", 0, 0), ipid
        try:
            process_key, tid = self.thread_mappings[thread_key]
            pid = process_key[1]
            if pid == tid and self.is_kernel(pid):
                return ("kernel", 0, 0), ipid
            return process_key, tid
        except KeyError:
            return ("kernel", 0, 0), ipid

    # Find processes which survive squelching and their first/last visible quantum.
    def find_visible_processes(
        self,
        process_cpus: ProcessCpus,
        duration_ns: int,
        quantum_count: int,
    ) -> Tuple[set[ProcessKey], Dict[ProcessKey, Tuple[int, int]]]:
        visible: set[ProcessKey] = set()
        first_last: Dict[ProcessKey, Tuple[int, int]] = {}
        for quanta in process_cpus.values():
            for quantum_index, cell in quanta.items():
                denominator = self.quantum_duration(
                    quantum_index, duration_ns, quantum_count
                )
                if denominator <= 0:
                    continue
                for key, runtime_ns in cell.items():
                    percent = runtime_ns * 100.0 / denominator
                    if percent < self.squelch:
                        continue
                    visible.add(key)
                    if key in first_last:
                        first, last = first_last[key]
                        first_last[key] = (
                            min(first, quantum_index),
                            max(last, quantum_index),
                        )
                    else:
                        first_last[key] = (quantum_index, quantum_index)
        return visible, first_last

    # Return the actual denominator for a quantum, including the partial final one.
    def quantum_duration(
        self, quantum_index: int, duration_ns: int, quantum_count: int
    ) -> int:
        if quantum_index < 0 or quantum_index >= quantum_count:
            return 0
        if quantum_index == quantum_count - 1:
            remainder = duration_ns - quantum_index * self.quantum_ns
            return remainder if remainder else self.quantum_ns
        return self.quantum_ns

    # Encode a process and all known threads belonging to it.
    def encode_process(
        self,
        key: ProcessKey,
        total_ns: int,
        scheduled_threads: Mapping[ThreadKey, int],
        first_last: Optional[Tuple[int, int]],
    ) -> Mapping[str, object]:
        kind, pid, generation = key
        if kind == "kernel":
            name = "kernel and unknown"
            public_pid: Optional[int] = None
        else:
            # Snapshot metadata describes the latest PID generation only.
            details = (
                self.proc_info.get(pid)
                if generation == self.public_generations.get(pid, 0)
                else None
            )
            process_name = basename(details.exe) if details and details.exe else None
            if not process_name and details and details.cmdline:
                process_name = basename(details.cmdline[0])
            if not process_name:
                process_name = self.process_names.get(key)
            if process_name is None and details is not None:
                process_name = details.comm
            name = process_name if process_name is not None else f"pid {pid}"
            public_pid = pid

        threads: List[Mapping[str, object]] = []
        scheduled_tids: set[int] = set()
        for thread_key in sorted(
            scheduled_threads,
            key=lambda item: (-scheduled_threads.get(item, 0), item),
        ):
            _thread_process, tid = self.resolve_process(thread_key)
            scheduled_tids.add(tid)
            thread_name = self.thread_names.get((key, tid))
            if thread_name is None:
                thread_name = self.internal_names.get(thread_key, f"tid {tid}")
            threads.append(
                {
                    "id": f"{tid}:{thread_key[1]}",
                    "tid": tid,
                    "name": thread_name,
                    "cpuMs": round(
                        scheduled_threads[thread_key] / NANOSECONDS_PER_MILLISECOND,
                        6,
                    ),
                }
            )

        if kind != "kernel":
            for (process_key, tid), thread_name in sorted(self.thread_names.items()):
                if process_key == key and tid not in scheduled_tids:
                    threads.append(
                        {
                            "id": f"{tid}:metadata",
                            "tid": tid,
                            "name": thread_name,
                            "cpuMs": 0.0,
                        }
                    )

        encoded_process: Dict[str, object] = {
            "id": "kernel" if kind == "kernel" else f"pid:{pid}:{generation}",
            "kind": kind,
            "pid": public_pid,
            "name": name,
            "cpuMs": round(total_ns / NANOSECONDS_PER_MILLISECOND, 6),
            "firstQuantum": first_last[0] if first_last else None,
            "lastQuantum": first_last[1] if first_last else None,
            "threads": threads,
        }
        if kind != "kernel" and pid in self.proc_info:
            details = self.proc_info[pid]
            encoded_process["comm"] = details.comm
            if details.exe is not None:
                encoded_process["executable"] = details.exe
            if details.cmdline is not None:
                encoded_process["commandLine"] = list(details.cmdline)
        return encoded_process

    # Encode only non-empty samples, folding small contributions into other.
    def encode_cpus(
        self,
        process_cpus: ProcessCpus,
        process_indexes: Mapping[ProcessKey, int],
        duration_ns: int,
        quantum_count: int,
    ) -> Tuple[List[Mapping[str, object]], int]:
        cpus: List[Mapping[str, object]] = []
        total_other_ns = 0
        for cpu in sorted(self.raw_cpus):
            samples: List[object] = []
            for quantum_index, cell in sorted(process_cpus[cpu].items()):
                denominator = self.quantum_duration(
                    quantum_index, duration_ns, quantum_count
                )
                if denominator <= 0:
                    continue
                entries: List[List[object]] = []
                other_ns = 0
                for key, runtime_ns in cell.items():
                    percent = runtime_ns * 100.0 / denominator
                    if percent < self.squelch:
                        other_ns += runtime_ns
                    else:
                        entries.append([process_indexes[key], round(percent, 4)])
                if other_ns:
                    entries.append(
                        [OTHER_PROCESS_INDEX, round(other_ns * 100.0 / denominator, 4)]
                    )
                    total_other_ns += other_ns
                entries.sort(key=lambda entry: cast(int, entry[0]))
                if entries:
                    samples.append([quantum_index, entries])
            cpus.append({"id": cpu, "samples": samples})
        return cpus, total_other_ns

    # Return a valid dataset when the input has no schedulable time range.
    def empty_result(self) -> Mapping[str, object]:
        return {
            "schema": SCHEMA,
            "trace": {
                "startTimeNs": "0",
                "durationMs": 0,
                "quantumMs": round(self.quantum_ns / NANOSECONDS_PER_MILLISECOND, 6),
                "quantumCount": 0,
                "squelchPercent": self.squelch,
                "cpuIds": [],
                "busyCpuMs": 0,
                "otherCpuMs": 0,
            },
            "source": self.source_metadata,
            "processes": [],
            "cpus": [],
            "events": [],
        }
