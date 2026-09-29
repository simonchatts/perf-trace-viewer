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

# Convert Linux `perf sched` data to detailed or aggregated visualization data.
#
# Run as in: perf_trace_viewer <input-file> <output-file>
# Or: perf_trace_viewer --aggregate --agg-time 0.2 <input-file> <output-file>
# Add a display title to aggregated JSON with --aggregate --title "Test run".

import sys

if sys.version_info < (3, 10):
    print("ERROR: python 3.10 or later required", file=sys.stderr)
    sys.exit(1)

import gzip
import json
import logging
import math
import tarfile
import zlib
from argparse import ArgumentParser, Namespace
from typing import IO, Iterable, Literal, Mapping, NoReturn, Optional, Sequence, Union

from engine import process_perf_data
from parse_jsonl import process_jsonl_data
from parse_mdata import parse_mdata
from quantized import process_quantized_perf_data

Output = Union[Sequence[Mapping[str, object]], Mapping[str, object]]


# Main entrypoint
def main() -> None:
    # Setup
    logging.basicConfig(level=logging.INFO)
    opts = get_opts()

    # Do the processing
    data = process_file(opts)

    # Save the result
    with open(opts.output_filename, "w", encoding="utf-8") as f:
        json.dump(data, f)


# Process command-line options
def get_opts() -> Namespace:
    parser = ArgumentParser(
        description=(
            "Convert collected `perf sched` data for detailed or aggregated viewing"
        )
    )
    parser.add_argument("input_filename", help="perf data input")
    parser.add_argument("output_filename", help="JSON output file")
    parser.add_argument(
        "--jsonl",
        action="store_true",
        help="Treat input as tspn JSONL instead of collected perf tar data",
    )
    parser.add_argument(
        "-q",
        "--aggregate",
        dest="quantized",
        action="store_true",
        help="Generate sparse aggregated CPU data for the web viewer",
    )
    parser.add_argument(
        "--agg-time",
        dest="quantum",
        type=float,
        default=0.2,
        metavar="SECONDS",
        help="Duration of each aggregation interval in seconds (default: 0.2)",
    )
    parser.add_argument(
        "--agg-min-percent",
        dest="squelch",
        type=float,
        default=1.0,
        metavar="PERCENT",
        help="Fold smaller per-process contributions into other (default: 1.0)",
    )
    parser.add_argument(
        "--title",
        help="Display title to include in aggregated JSON for the web viewer",
    )
    parser.add_argument(
        "-s",
        "--skip",
        type=float,
        default=0.0,
        help="Number of seconds of data to skip",
    )
    parser.add_argument(
        "-d",
        "--duration",
        type=float,
        default=0.0,
        help="Number of seconds of data to process",
    )
    parser.add_argument(
        "-w",
        "--wait",
        type=float,
        default=3.0,
        help="Threshold (in ms) for tasks to appear in the waiting track",
    )
    opts = parser.parse_args()
    if not math.isfinite(opts.quantum) or opts.quantum < 0.000000001:
        parser.error("--agg-time must be at least one nanosecond")
    if not math.isfinite(opts.squelch) or opts.squelch < 0 or opts.squelch > 100:
        parser.error("--agg-min-percent must be between 0 and 100")
    if not opts.quantized and (opts.quantum != 0.2 or opts.squelch != 1.0):
        parser.error("--agg-time and --agg-min-percent require --aggregate")
    if opts.title is not None and not opts.quantized:
        parser.error("--title requires --aggregate")
    if opts.jsonl and opts.quantized:
        parser.error("--aggregate does not support --jsonl input")
    return opts


# Run the engine on either compressed test data, or a real perf data file
def process_file(opts: Namespace) -> Output:
    if opts.jsonl:
        if opts.skip or opts.duration or opts.wait != 3.0:
            logging.warning("--skip/--duration/--wait are ignored with --jsonl")
        with open(opts.input_filename, encoding="utf-8") as f:
            return process_jsonl_data(f)

    # Use filename suffixes to select gzip and uncompressed tar explicitly;
    # keep transparent detection for other supported compression formats.
    # There should be exactly two files, in this order:
    #   - perf-mdata.txt (containing metadata)
    #   - perf.data.txt or perf.data.txt.gz (containing the output of perf script)
    # We fully read in the mdata, then start streaming the perf data.
    tar_mode: Literal["r:gz", "r:", "r:*"] = (
        "r:gz"
        if opts.input_filename.endswith(".gz")
        else "r:"
        if opts.input_filename.endswith(".tar")
        else "r:*"
    )
    try:
        with tarfile.open(opts.input_filename, mode=tar_mode) as tar:
            mdata, proc_info = None, None
            result: Optional[Output] = None
            for member in tar.getmembers():
                if member.name == "perf-mdata.txt":
                    mdata, proc_info = parse_mdata(extract(tar, member))
                    if opts.title is not None and mdata is not None:
                        mdata["title"] = opts.title
                elif member.name in ("perf.data.txt", "perf.data.txt.gz"):
                    if mdata is None or proc_info is None:
                        die(
                            "ERROR: perf-mdata.txt not early enough - "
                            "possible corruption?"
                        )
                    lines = stream_perf_data(tar, member)
                    # Send the stream to the engine, along with everything else it needs
                    if opts.quantized:
                        if opts.wait != 3.0:
                            logging.warning("--wait is ignored with --aggregate")
                        result = process_quantized_perf_data(
                            lines,
                            mdata,
                            proc_info,
                            opts.skip,
                            opts.duration,
                            opts.quantum,
                            opts.squelch,
                        )
                    else:
                        result = process_perf_data(
                            lines, mdata, proc_info, opts.skip, opts.duration, opts.wait
                        )
    except (tarfile.TarError, gzip.BadGzipFile, EOFError, zlib.error) as error:
        die(
            f"ERROR: cannot read perf data archive '{opts.input_filename}': {error}",
            "The archive or compressed perf data appears truncated or corrupt; "
            "verify it with "
            "'tar -t' (and the compressor's integrity check) and collect it again "
            "if necessary.",
        )

    if result is None:
        die(
            "ERROR: perf.data.txt or perf.data.txt.gz missing from tarfile - "
            "possible corruption?"
        )
    else:
        return result


# Stream any binary line iterator as decoded perf-script text.
def stream(f: Iterable[bytes]) -> Iterable[str]:
    for line in f:
        yield line.decode("utf-8")


# Stream either the plain or gzip-compressed perf script member without loading
# the potentially very large member into memory.
def stream_perf_data(tar: tarfile.TarFile, member: tarfile.TarInfo) -> Iterable[str]:
    raw = extract(tar, member)
    if member.name.endswith(".gz"):
        with gzip.GzipFile(fileobj=raw, mode="rb") as decompressed:
            yield from stream(decompressed)
    else:
        yield from stream(raw)


# Extract a member of a tarfile
def extract(tar: tarfile.TarFile, member: tarfile.TarInfo) -> IO[bytes]:
    file = tar.extractfile(member)
    if file is None:
        die(f"ERROR: Can't extract {member.name} - possible corruption?")
    else:
        return file


# Exit with an error message
def die(*msgs: str) -> NoReturn:
    for msg in msgs:
        print(msg, file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
