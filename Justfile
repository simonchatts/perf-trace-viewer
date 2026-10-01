# List the development, verification, and deployment recipes.
_list:
    @just --list

# Run Python tests/checks plus web formatting, typechecking, and build validation.
ci:
    ruff check --select E,F,I generate_index.py perf_trace_viewer/quantized.py perf_trace_viewer/quantized_test.py perf_trace_viewer/__main__.py perf_trace_viewer/parse_jsonl.py
    ruff format --check generate_index.py perf_trace_viewer/quantized.py perf_trace_viewer/quantized_test.py perf_trace_viewer/__main__.py perf_trace_viewer/parse_jsonl.py
    mypy --strict perf_trace_viewer
    python3 perf_trace_viewer/parse_perf_script.py
    python3 perf_trace_viewer/parse_mdata.py
    python3 perf_trace_viewer/quantized_test.py
    npm run test:plugin
    npm run format:check
    npm run typecheck
    npm run build

# Start the Vite development server.
dev:
    npm run dev

# Build relocatable production assets into dist/.
build:
    npm run build

# Replace these deployment placeholders with the target host and serving path.
deploy:
    npm run build && \
    (cd dist && \
     tar zcf - . | \
      ssh WEB_SERVER 'cd SERVING_PATH && rm -rf * && tar zxvf -')
