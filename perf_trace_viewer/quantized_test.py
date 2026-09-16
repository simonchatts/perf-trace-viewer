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

# Tests for the quantized scheduling aggregation and compact data contract.

import unittest
from typing import Dict, List, Mapping, Optional, Union, cast

from parse_mdata import ProcStat
from quantized import QuantizedEngine


# Format one synthetic perf sched switch line.
def switch(
    timestamp: float,
    opid: int,
    otid: int,
    prev_pid: int,
    prev_name: str,
    next_pid: int,
    next_name: str,
    cpu: int = 0,
) -> str:
    return (
        f" {opid}/{otid} [{cpu:03d}] {timestamp:.9f}: sched:sched_switch: "
        f"prev_comm={prev_name} prev_pid={prev_pid} prev_prio=120 "
        f"prev_state=S ==> next_comm={next_name} next_pid={next_pid} "
        "next_prio=120\n"
    )


# Format one synthetic perf process/thread metadata line.
def comm(name: str, pid: int, tid: int) -> str:
    return f" 0/0 [000] 0.000000000: PERF_RECORD_COMM: {name}:{pid}/{tid}\n"


# Format one synthetic process lifecycle record.
def lifecycle(
    event: str,
    timestamp: float,
    pid: int,
    tid: int,
    parent_pid: int,
    parent_tid: int,
) -> str:
    return (
        f" {pid}/{tid} [000] {timestamp:.9f}: PERF_RECORD_{event}"
        f"({pid}:{tid}):({parent_pid}:{parent_tid})\n"
    )


# Format one supported process-manager SDT marker.
def sdt(
    timestamp: float,
    name: str,
    args: Optional[Union[int, Mapping[str, int]]] = None,
) -> str:
    if isinstance(args, int):
        args = {"arg1": args}
    argument = (
        ""
        if args is None
        else " " + " ".join(f"{key}={value}" for key, value in args.items())
    )
    return (
        f" 70/71 [000] {timestamp:.9f}: sdt_processmgr:{name}: "
        f"(56352c06f6e5){argument}\n"
    )


# Format an SDT marker from an arbitrary provider.
def sdt_provider(
    timestamp: float,
    provider: str,
    name: str,
    args: Optional[Union[int, Mapping[str, int]]] = None,
) -> str:
    if isinstance(args, int):
        args = {"arg1": args}
    argument = (
        ""
        if args is None
        else " " + " ".join(f"{key}={value}" for key, value in args.items())
    )
    return (
        f" 70/71 [000] {timestamp:.9f}: sdt_{provider}:{name}: "
        f"(56352c06f6e5){argument}\n"
    )


class QuantizedEngineTests(unittest.TestCase):
    """Exercise aggregation boundaries, squelching, and process metadata."""

    # Run a compact synthetic trace through a configured engine.
    def run_engine(
        self,
        lines: List[str],
        quantum_ms: int = 1000,
        squelch: float = 5.0,
    ) -> Mapping[str, object]:
        engine = QuantizedEngine(
            skip_ns=0,
            duration_ns=0,
            quantum_ns=quantum_ms * 1_000_000,
            squelch=squelch,
            is_kernel=lambda _pid: False,
            proc_info={},
            source_metadata={"system": "synthetic"},
        )
        return engine.process(lines)

    def test_threads_are_aggregated_into_process_percentage(self) -> None:
        lines = [
            comm("worker", 10, 10),
            comm("helper", 10, 11),
            switch(1.000, 0, 0, 0, "idle", 10, "worker"),
            switch(1.025, 10, 10, 10, "worker", 0, "idle"),
            switch(1.050, 0, 0, 0, "idle", 11, "helper"),
            switch(1.075, 10, 11, 11, "helper", 0, "idle"),
            switch(2.000, 0, 0, 0, "idle", 0, "idle"),
        ]
        result = self.run_engine(lines)
        processes = cast(List[Mapping[str, object]], result["processes"])
        cpus = cast(List[Mapping[str, object]], result["cpus"])

        self.assertEqual(len(processes), 1)
        self.assertEqual(processes[0]["pid"], 10)
        self.assertEqual(processes[0]["cpuMs"], 50.0)
        self.assertEqual(len(cast(List[object], processes[0]["threads"])), 2)
        self.assertEqual(cpus[0]["samples"], [[0, [[0, 5.0]]]])

    def test_hidden_process_is_only_encoded_as_other(self) -> None:
        lines = [
            comm("tiny", 20, 20),
            switch(1.000, 0, 0, 0, "idle", 20, "tiny"),
            switch(1.040, 20, 20, 20, "tiny", 0, "idle"),
            switch(2.000, 0, 0, 0, "idle", 0, "idle"),
        ]
        result = self.run_engine(lines)
        processes = cast(List[Mapping[str, object]], result["processes"])
        cpus = cast(List[Mapping[str, object]], result["cpus"])

        self.assertEqual(processes, [])
        self.assertEqual(cpus[0]["samples"], [[0, [[-1, 4.0]]]])

    def test_partial_final_quantum_uses_its_actual_duration(self) -> None:
        lines = [
            comm("worker", 30, 30),
            switch(1.000, 0, 0, 0, "idle", 30, "worker"),
            switch(1.250, 30, 30, 30, "worker", 0, "idle"),
            switch(1.500, 0, 0, 0, "idle", 0, "idle"),
        ]
        result = self.run_engine(lines)
        cpus = cast(List[Mapping[str, object]], result["cpus"])
        trace = cast(Dict[str, object], result["trace"])

        self.assertEqual(trace["durationMs"], 500.0)
        self.assertEqual(cpus[0]["samples"], [[0, [[0, 50.0]]]])

    def test_visible_process_totals_include_squelched_quanta(self) -> None:
        lines = [
            comm("bursty", 40, 40),
            switch(1.000, 0, 0, 0, "idle", 40, "bursty"),
            switch(1.100, 40, 40, 40, "bursty", 0, "idle"),
            switch(2.000, 0, 0, 0, "idle", 40, "bursty"),
            switch(2.040, 40, 40, 40, "bursty", 0, "idle"),
            switch(3.000, 0, 0, 0, "idle", 0, "idle"),
        ]
        result = self.run_engine(lines)
        processes = cast(List[Mapping[str, object]], result["processes"])
        cpus = cast(List[Mapping[str, object]], result["cpus"])

        self.assertEqual(processes[0]["cpuMs"], 140.0)
        self.assertEqual(processes[0]["firstQuantum"], 0)
        self.assertEqual(processes[0]["lastQuantum"], 0)
        self.assertEqual(
            cpus[0]["samples"],
            [[0, [[0, 10.0]]], [1, [[-1, 4.0]]]],
        )

    def test_kernel_threads_share_one_process(self) -> None:
        lines = [
            comm("kworker/0", 50, 50),
            comm("kworker/1", 51, 51),
            switch(1.000, 0, 0, 0, "idle", 50, "kworker/0"),
            switch(1.100, 50, 50, 50, "kworker/0", 51, "kworker/1"),
            switch(1.200, 51, 51, 51, "kworker/1", 0, "idle"),
            switch(2.000, 0, 0, 0, "idle", 0, "idle"),
        ]
        engine = QuantizedEngine(
            skip_ns=0,
            duration_ns=0,
            quantum_ns=1_000_000_000,
            squelch=5.0,
            is_kernel=lambda pid: pid in {50, 51},
            proc_info={},
            source_metadata={},
        )
        result = engine.process(lines)
        processes = cast(List[Mapping[str, object]], result["processes"])
        threads = cast(List[Mapping[str, object]], processes[0]["threads"])

        self.assertEqual(processes[0]["id"], "kernel")
        self.assertEqual(processes[0]["cpuMs"], 200.0)
        self.assertEqual({thread["tid"] for thread in threads}, {50, 51})

    def test_reused_pid_creates_distinct_process_instances(self) -> None:
        lines = [
            comm("first", 60, 60),
            switch(1.000, 0, 0, 0, "idle", 60, "first"),
            switch(1.100, 60, 60, 60, "first", 0, "idle"),
            lifecycle("EXIT", 1.200, 60, 60, 1, 1),
            lifecycle("FORK", 1.900, 60, 60, 1, 1),
            comm("second", 60, 60),
            switch(2.000, 0, 0, 0, "idle", 60, "second"),
            switch(2.200, 60, 60, 60, "second", 0, "idle"),
            switch(3.000, 0, 0, 0, "idle", 0, "idle"),
        ]
        result = self.run_engine(lines)
        processes = cast(List[Mapping[str, object]], result["processes"])

        self.assertEqual(
            [
                (process["id"], process["name"], process["cpuMs"])
                for process in processes
            ],
            [
                ("pid:60:1", "second", 200.0),
                ("pid:60:0", "first", 100.0),
            ],
        )

    def test_proc_details_supply_display_name_and_attributes(self) -> None:
        proc = ProcStat._make(
            [70, "short-comm", "S"]
            + [0] * (len(ProcStat._fields) - 5)
            + ["/opt/process/bin/process-manager", ("process-manager", "--boot")]
        )
        engine = QuantizedEngine(
            skip_ns=0,
            duration_ns=0,
            quantum_ns=1_000_000_000,
            squelch=5.0,
            is_kernel=lambda _pid: False,
            proc_info={70: proc},
            source_metadata={},
        )
        result = engine.process(
            [
                comm("short-comm", 70, 70),
                switch(1.000, 0, 0, 0, "idle", 70, "short-comm"),
                switch(1.100, 70, 70, 70, "short-comm", 0, "idle"),
                switch(2.000, 0, 0, 0, "idle", 0, "idle"),
            ]
        )
        process = cast(List[Mapping[str, object]], result["processes"])[0]

        self.assertEqual(process["name"], "process-manager")
        self.assertEqual(process["comm"], "short-comm")
        self.assertEqual(process["executable"], "/opt/process/bin/process-manager")
        self.assertEqual(process["commandLine"], ["process-manager", "--boot"])

    def test_sdt_events_are_grouped_at_containing_quantum_boundary(self) -> None:
        result = self.run_engine(
            [
                switch(1.000, 0, 0, 0, "idle", 70, "worker"),
                sdt(1.900, "band_begin", 2000),
                sdt(1.950, "band_submitted", 2000),
                sdt(2.100, "boot_complete"),
                switch(3.000, 70, 70, 70, "worker", 0, "idle"),
            ]
        )

        self.assertEqual(
            result["events"],
            [
                {
                    "quantum": 0,
                    "category": "sdt_processmgr",
                    "events": [
                        {
                            "name": "band_begin",
                            "args": {"arg1": 2000},
                            "timestampMs": 900.0,
                        },
                        {
                            "name": "band_submitted",
                            "args": {"arg1": 2000},
                            "timestampMs": 950.0,
                        },
                    ],
                },
                {
                    "quantum": 1,
                    "category": "sdt_processmgr",
                    "events": [{"name": "boot_complete", "timestampMs": 1100.0}],
                },
            ],
        )

    def test_sdt_events_from_any_provider_are_retained(self) -> None:
        result = self.run_engine(
            [
                switch(1.000, 0, 0, 0, "idle", 70, "worker"),
                sdt_provider(1.900, "cfgmgr", "config_replay_start"),
                sdt_provider(2.100, "cfgmgr", "config_replay_end"),
                switch(3.000, 70, 70, 70, "worker", 0, "idle"),
            ]
        )

        self.assertEqual(
            result["events"],
            [
                {
                    "quantum": 0,
                    "category": "sdt_cfgmgr",
                    "events": [
                        {
                            "name": "config_replay_start",
                            "timestampMs": 900.0,
                        }
                    ],
                },
                {
                    "quantum": 1,
                    "category": "sdt_cfgmgr",
                    "events": [
                        {
                            "name": "config_replay_end",
                            "timestampMs": 1100.0,
                        }
                    ],
                },
            ],
        )

    def test_sdt_events_retain_all_named_arguments(self) -> None:
        result = self.run_engine(
            [
                switch(1.000, 0, 0, 0, "idle", 70, "worker"),
                sdt(
                    1.900,
                    "band_remaining",
                    {
                        "arg1": 11297,
                        "arg2": 11320,
                        "arg3": 11340,
                        "arg4": 11347,
                        "arg5": 0,
                    },
                ),
                switch(2.000, 70, 70, 70, "worker", 0, "idle"),
            ]
        )

        self.assertEqual(
            result["events"],
            [
                {
                    "quantum": 0,
                    "category": "sdt_processmgr",
                    "events": [
                        {
                            "name": "band_remaining",
                            "args": {
                                "arg1": 11297,
                                "arg2": 11320,
                                "arg3": 11340,
                                "arg4": 11347,
                                "arg5": 0,
                            },
                            "timestampMs": 900.0,
                        }
                    ],
                }
            ],
        )

    def test_sdt_provider_groups_do_not_merge_within_one_quantum(self) -> None:
        result = self.run_engine(
            [
                switch(1.000, 0, 0, 0, "idle", 70, "worker"),
                sdt(1.900, "band_begin", 2000),
                sdt_provider(1.950, "cfgmgr", "config_replay_start"),
                switch(2.000, 70, 70, 70, "worker", 0, "idle"),
            ]
        )

        self.assertEqual(
            [
                (group["category"], group["quantum"])
                for group in cast(List[Mapping[str, object]], result["events"])
            ],
            [("sdt_cfgmgr", 0), ("sdt_processmgr", 0)],
        )


if __name__ == "__main__":
    unittest.main()
