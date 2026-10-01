#!/usr/bin/env python3
"""Generate a compact static index of traces in the current directory.

Examples:
    ./generate_index.py
    ./generate_index.py --ui dist/index.html --output traces.html
"""

import argparse
import html
import json
import os
from pathlib import Path
from urllib.parse import quote, urlencode


# Express a target file as a URL relative to the file that links to it.
def relative_url(target: Path, source: Path) -> str:
    relative = os.path.relpath(target.resolve(), source.resolve().parent)
    return quote(Path(relative).as_posix(), safe="/")


# Read only the metadata needed for an index card from a trace file.
def trace_metadata(path: Path) -> tuple[str, str]:
    with path.open(encoding="utf-8") as source:
        trace = json.load(source)
    metadata = trace.get("source", {})
    if not isinstance(metadata, dict):
        metadata = {}
    title = metadata.get("title") or path.stem
    date = metadata.get("date") or ""
    return str(title), str(date)


# Build one clickable card with an encoded viewer URL and escaped visible text.
def trace_card(dataset: Path, plugin: Path | None, ui: Path, output: Path) -> str:
    title, date = trace_metadata(dataset)
    query = {"data": relative_url(dataset, ui)}
    if plugin is not None:
        query["sdt"] = relative_url(plugin, ui)
    href = f"{relative_url(ui, output)}?{urlencode(query)}"
    return (
        f'<a class="trace" href="{html.escape(href, quote=True)}">'
        f"<strong>{html.escape(title)}</strong>"
        f"<span>{html.escape(date)}</span>"
        f"<code>{html.escape(dataset.name)}</code>"
        "</a>"
    )


# Prefer filesystem creation time, falling back to modification time where absent.
def creation_time(path: Path) -> float:
    details = path.stat()
    return getattr(details, "st_birthtime", details.st_mtime)


# Scan the current directory and write an index referencing the shared viewer.
def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--ui", type=Path, default=Path("dist/index.html"), help="built viewer HTML"
    )
    parser.add_argument(
        "--output", type=Path, default=Path("index.html"), help="generated index HTML"
    )
    args = parser.parse_args()

    datasets = sorted(
        Path.cwd().glob("*.json"),
        key=lambda path: (-creation_time(path), path.name),
    )
    plugins = sorted(Path.cwd().glob("*.js"))
    if not datasets:
        parser.error("the current directory contains no .json files")
    if len(plugins) > 1:
        parser.error("the current directory contains more than one .js file")
    if not args.ui.is_file():
        parser.error(f"built viewer does not exist: {args.ui}")

    plugin = plugins[0] if plugins else None
    cards = "\n".join(
        trace_card(dataset, plugin, args.ui, args.output) for dataset in datasets
    )
    icon = html.escape(
        relative_url(args.ui.parent / "icon.svg", args.output), quote=True
    )
    page = f"""<!doctype html>
<html lang="en" style="background:#07182d">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#07182d">
  <title>Perf Trace Viewer — datasets</title>
  <style>
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; min-height: 100vh; color: #d9f7ff; background:
      radial-gradient(circle at 80% -10%, #0a60ff33, transparent 38rem), #07182d;
      font-family: system-ui, sans-serif; }}
    header {{ display: flex; align-items: center; gap: 13px; min-height: 78px;
      padding: 12px clamp(20px, 4vw, 58px); border-bottom: 1px solid #81b1cf29; }}
    header img {{ width: 42px; height: 42px; }}
    header strong {{ color: #f1fcff; }}
    main {{ max-width: 900px; margin: 32px auto; padding: 0 20px; }}
    h1 {{ margin: 0 0 18px; font-size: 25px; }}
    .trace {{ display: grid; grid-template-columns: minmax(0, 1fr) auto;
      gap: 3px 16px; padding: 12px 16px; margin: 8px 0;
      border: 1px solid #335872; border-radius: 8px; background: #0a2139;
      color: inherit; text-decoration: none; }}
    .trace:hover, .trace:focus-visible {{ border-color: #02c8ff; background: #10304f; }}
    .trace strong {{ min-width: 0; overflow-wrap: anywhere; }}
    .trace span {{ color: #a9c0cf; font-size: 13px; text-align: right; }}
    .trace code {{ grid-column: 1 / -1; color: #7d9aad; font-size: 12px;
      overflow-wrap: anywhere; }}
    @media (max-width: 550px) {{
      .trace {{ grid-template-columns: 1fr; }}
      .trace span {{ text-align: left; }}
    }}
  </style>
</head>
<body>
  <header><img src="{icon}" alt=""><strong>Perf Trace Viewer</strong></header>
  <main><h1>Datasets</h1>
{cards}
  </main>
</body>
</html>
"""
    args.output.write_text(page, encoding="utf-8")
    print(f"Wrote {args.output} with {len(datasets)} datasets.")


if __name__ == "__main__":
    main()
