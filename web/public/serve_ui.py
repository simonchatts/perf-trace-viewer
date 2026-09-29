#!/usr/bin/env python3
"""Serve the bundled static viewer with Python's standard library.

Examples:
    ./serve_ui.py                         # serve on http://127.0.0.1:8000
    ./serve_ui.py --host 0.0.0.0 --port 9000
    ./perf_trace_ui --port 8080            # run the self-contained release zipapp
    python3 serve_ui.py --port 8080
"""

import argparse
from contextlib import ExitStack
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
import zipfile


# Extract the zipapp's static files temporarily; regular runs serve beside this script.
def serving_directory(stack: ExitStack) -> Path:
    archive = Path(sys.argv[0]).resolve()
    if not zipfile.is_zipfile(archive):
        return Path(__file__).resolve().parent

    directory = Path(stack.enter_context(tempfile.TemporaryDirectory()))
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.infolist():
            if member.is_dir() or member.filename == "__main__.py":
                continue
            destination = (directory / member.filename).resolve()
            destination.relative_to(directory.resolve())
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(bundle.read(member))
    return directory


# Serve files relative to the extracted UI bundle, independent of the current cwd.
def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the static Perf Trace Viewer")
    parser.add_argument(
        "--host", default="127.0.0.1", help="address to listen on (default: localhost)"
    )
    parser.add_argument(
        "--port", type=int, default=8000, help="port to listen on (default: 8000)"
    )
    args = parser.parse_args()

    with ExitStack() as stack:
        directory = serving_directory(stack)
        handler = partial(SimpleHTTPRequestHandler, directory=str(directory))
        server = ThreadingHTTPServer((args.host, args.port), handler)
        print(f"Serving {directory} at http://{args.host}:{args.port}/")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nStopping server")
        finally:
            server.server_close()


if __name__ == "__main__":
    main()
