#!/usr/bin/env python3
#
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

# This module parses tspn.jsonl-style input and converts it into Chrome Trace
# Event format.

import json
import logging
from typing import Dict, Iterable, List, Mapping, Tuple, Union

from trace_event import BeginEvent, EndEvent, ProcessNameEvent, ThreadNameEvent
from utils import EventList, PidMapper

Span = Tuple[int, int, int, int, str, Dict[str, Union[str, int]]]


def process_jsonl_data(lines: Iterable[str]) -> List[Mapping[str, object]]:
    process_names: Dict[int, str] = {}
    thread_names: Dict[Tuple[int, int], str] = {}
    spans: List[Span] = []

    for lineno, line in enumerate(lines, start=1):
        line = line.strip()
        if not line:
            continue

        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            logging.warning("Ignoring invalid JSONL line %d", lineno)
            continue

        if not isinstance(obj, dict):
            logging.warning("Ignoring JSONL line %d that is not an object", lineno)
            continue

        pid = as_int(obj.get("pid"))
        tid = as_int(obj.get("tid"))
        if pid <= 0 or tid <= 0:
            logging.warning("Ignoring JSONL line %d with invalid pid/tid", lineno)
            continue

        process_name = str(obj.get("process", f"pid {pid}"))
        thread_name = str(obj.get("thread", process_name))
        process_names.setdefault(pid, process_name)
        thread_names.setdefault((pid, tid), thread_name)

        first_ts = as_int(obj.get("first_ts"))
        last_ts = as_int(obj.get("last_ts"))
        if first_ts <= 0 or last_ts <= first_ts:
            continue

        spans.append((pid, tid, first_ts, last_ts, span_name(obj), span_args(obj)))

    pid_mapper = PidMapper()
    events = EventList(pid_mapper)

    for pid, name in sorted(process_names.items()):
        events.append(ProcessNameEvent(pid, name))

    for (pid, tid), name in sorted(thread_names.items()):
        events.append(ThreadNameEvent(pid, tid, name))

    spans.sort(key=lambda s: (s[2], s[3], s[0], s[1], s[4]))
    for pid, tid, first_ts, last_ts, name, args in spans:
        events.append(BeginEvent(name=name, pid=pid, tid=tid, ts=first_ts, args=args))
        events.append(EndEvent(name=name, pid=pid, tid=tid, ts=last_ts))

    return events.aslist()


def as_int(raw: object) -> int:
    # Coerce the primitive JSON values that Python's int constructor accepts.
    if not isinstance(raw, (str, bytes, bytearray, int, float)):
        return 0
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 0


def span_name(obj: Mapping[str, object]) -> str:
    caller = str(obj.get("caller_fn", "")).strip()
    callee = str(obj.get("callee_fn", "")).strip()
    if caller and callee and caller != callee and callee != "??":
        return f"{caller} -> {callee}"
    elif callee and callee != "??":
        return callee
    elif caller and caller != "??":
        return caller
    else:
        return str(obj.get("type", "span"))


def span_args(obj: Mapping[str, object]) -> Dict[str, Union[str, int]]:
    args: Dict[str, Union[str, int]] = {}
    for k in (
        "id",
        "parent",
        "type",
        "count",
        "net",
        "net_avg",
        "total",
        "avg",
        "stddev",
        "min",
        "max",
        "caller_dso",
        "caller_fn",
        "callee_dso",
        "callee_fn",
    ):
        if k in obj:
            v = obj[k]
            if isinstance(v, (str, int)):
                args[k] = v
    return args
