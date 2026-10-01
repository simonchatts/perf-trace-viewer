#!/usr/bin/env node
/* Check the browser SDT plugin contract with Node's test runner.
 * Run: ./web/tests/sdtPlugin.test.mjs
 * Run: npm run test:plugin
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkPluginSyntax,
  compilePlugin,
  transformSdtEvents,
} from "../src/sdtPlugin.ts";

const trace = {
  events: [
    {
      quantum: 2,
      category: "sdt_process_mgr",
      events: [
        { name: "band_remaining", args: { arg1: 10 }, timestampMs: 2100 },
      ],
    },
  ],
  processes: [],
  pidTable: [
    { id: "pid:10:0", pid: 10, name: "first" },
    { id: "pid:10:1", pid: 10, name: "second" },
  ],
};

test("glob rules fall through on null and expose every PID match", () => {
  const rules = compilePlugin(`[
    { category: "sdt_*", name: "band_?emaining", transform: () => null },
    { category: "sdt_process_mgr", name: "band_*", transform: (event, context) => ({
      category: "bands",
      label: context.lookupPid(event.args.arg1).map((item) => item.name).join(" / "),
    }) },
  ]`);
  const result = transformSdtEvents(trace, rules);
  assert.equal(result[0].category, "bands");
  assert.equal(result[0].events[0].label, "first / second");
  assert.equal(trace.events[0].events[0].label, undefined);
});

test("syntax, result, and callback errors are reported", () => {
  checkPluginSyntax("[globalThis.pluginDraftExecuted = true]");
  assert.equal(globalThis.pluginDraftExecuted, undefined);
  assert.throws(() => compilePlugin("[{"), SyntaxError);
  assert.throws(() => compilePlugin("[{}]"), /Rule 1 needs/);
  assert.throws(
    () =>
      transformSdtEvents(
        trace,
        compilePlugin('[{category:"*",name:"*",transform:()=>({})}]'),
      ),
    /invalid result/,
  );
  assert.throws(
    () =>
      transformSdtEvents(
        trace,
        compilePlugin('[{category:"*",name:"*",transform:()=>missingName}]'),
      ),
    /Rule 1 failed on sdt_process_mgr:band_remaining/,
  );
});
