import { describe, expect, it } from "vitest";
import { checkDispatchInputs, workflowDispatch } from "./dispatch";

const release = `
name: Release
on:
  push:
    branches: [main]
  # Started by hand from the Actions tab or the dashboard.
  workflow_dispatch:
    inputs:
      channel:
        description: Where to publish
        type: choice
        options: [beta, stable]
        default: beta
      dry_run:
        type: boolean
        default: false
      build:
        description: Build number
        required: true
        type: number
      note:
        required: false
jobs:
  ship:
    runs-on: macos-latest
    steps:
      - run: echo ok
`;

describe("workflowDispatch", () => {
  it("reads a workflow_dispatch trigger's inputs, with types, defaults and options", () => {
    expect(workflowDispatch(release)).toEqual({
      inputs: [
        { name: "channel", description: "Where to publish", required: false, type: "choice", default: "beta", options: ["beta", "stable"] },
        { name: "dry_run", description: null, required: false, type: "boolean", default: "false", options: [] },
        { name: "build", description: "Build number", required: true, type: "number", default: null, options: [] },
        { name: "note", description: null, required: false, type: "string", default: null, options: [] },
      ],
    });
  });

  it("finds the trigger written as a string, a list or an empty map entry", () => {
    expect(workflowDispatch("on: workflow_dispatch\njobs: {}\n")).toEqual({ inputs: [] });
    expect(workflowDispatch("on: [push, workflow_dispatch]\njobs: {}\n")).toEqual({ inputs: [] });
    expect(workflowDispatch("on:\n  workflow_dispatch:\n  push:\njobs: {}\n")).toEqual({ inputs: [] });
  });

  it("answers null for a workflow without it, one that only mentions it, and YAML that does not parse", () => {
    expect(workflowDispatch("on: push\njobs: {}\n")).toBeNull();
    expect(workflowDispatch("on: push\n# workflow_dispatch is off for now\njobs:\n  a:\n    name: workflow_dispatch\n")).toBeNull();
    expect(workflowDispatch("on: [push\n")).toBeNull();
    expect(workflowDispatch("just text")).toBeNull();
  });
});

describe("checkDispatchInputs", () => {
  const spec = workflowDispatch(release)!;

  it("passes the values given, as strings, leaving defaults to GitHub", () => {
    expect(checkDispatchInputs(spec, { build: "42", channel: "stable" })).toEqual({ inputs: { channel: "stable", build: "42" }, problems: [] });
  });

  it("names every problem: unknown, missing, not a boolean, not a number, outside the choices", () => {
    expect(checkDispatchInputs(spec, { nope: "1", dry_run: "yes", channel: "nightly" }).problems).toEqual([
      "the workflow has no input named nope",
      "channel must be one of beta, stable",
      "dry_run must be true or false",
      "build is required",
    ]);
    expect(checkDispatchInputs(spec, { build: "many" }).problems).toEqual(["build must be a number"]);
  });
});
