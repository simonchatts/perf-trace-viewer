#!/usr/bin/env python3
"""Serve the bundled static viewer with Python's standard library.

Examples:
    ./serve_ui.py                         # serve on http://127.0.0.1:8000
    ./serve_ui.py --host 0.0.0.0 --port 9000
    python3 serve_ui.py --port 8080
"""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


# Serve files relative to this script, so the extracted release works from any cwd.
def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the static Perf Trace Viewer")
    parser.add_argument(
        "--host", default="127.0.0.1", help="address to listen on (default: localhost)"
    )
    parser.add_argument(
        "--port", type=int, default=8000, help="port to listen on (default: 8000)"
    )
    args = parser.parse_args()

    directory = Path(__file__).resolve().parent
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
