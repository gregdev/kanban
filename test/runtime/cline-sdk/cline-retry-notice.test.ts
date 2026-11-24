import { describe, expect, it } from "vitest";

import { summarizeClineRecoverableError } from "../../../src/cline-sdk/cline-retry-notice";

// Verbatim diagnostic from task 05762, where deepseek-flash emitted invalid JSON
// escapes for a search_codebase query and the SDK mistake tracker reported it.
const REAL_INVALID_ARGUMENTS_FAILURE = `1 tool call(s) failed: [search_codebase] {"error":"Tool call search_codebase emitted invalid JSON arguments: Tool call arguments could not be parsed as JSON. Ensure the outer tool payload is valid JSON and escape embedded quotes/newlines inside string fields."}`;

describe("summarizeClineRecoverableError", () => {
	it("summarizes the invalid-JSON tool failure from task 05762 without leaking SDK JSON", () => {
		const summary = summarizeClineRecoverableError(REAL_INVALID_ARGUMENTS_FAILURE);

		expect(summary).toBe("malformed tool arguments for search_codebase");
		expect(summary).not.toContain('{"error"');
	});

	it("lists every tool whose arguments failed to parse", () => {
		const summary = summarizeClineRecoverableError(
			`2 tool call(s) failed: [search_codebase] {"error":"Tool call search_codebase emitted invalid JSON arguments: nope."}; [run_commands] {"error":"Tool call run_commands emitted invalid JSON arguments: nope."}`,
		);

		expect(summary).toBe("malformed tool arguments for search_codebase, run_commands");
	});

	it("caps the listed tool names", () => {
		const summary = summarizeClineRecoverableError(
			`4 tool call(s) failed: [alpha] {"error":"Tool call alpha emitted invalid JSON arguments: nope."}; [beta] {"error":"Tool call beta emitted invalid JSON arguments: nope."}; [gamma] {"error":"Tool call gamma emitted invalid JSON arguments: nope."}; [delta] {"error":"Tool call delta emitted invalid JSON arguments: nope."}`,
		);

		expect(summary).toBe("malformed tool arguments for alpha, beta, gamma +1 more");
	});

	it("summarizes loop-detection failures", () => {
		const summary = summarizeClineRecoverableError(
			"1 tool call(s) failed: Detected 5 consecutive identical calls to `run_commands`; stopping to avoid a loop.",
		);

		expect(summary).toBe("repeated calls to run_commands");
	});

	it("keeps a generic failure readable when the tool threw", () => {
		const summary = summarizeClineRecoverableError(
			'1 tool call(s) failed: [run_commands] {"error":"Command exited with code 1"}',
		);

		expect(summary).toBe("1 failed tool call (run_commands)");
	});

	it("falls back to the reported count when details are missing", () => {
		expect(summarizeClineRecoverableError("2 tool call(s) failed")).toBe("2 failed tool calls");
	});

	it("passes unrecognised failure details through untouched", () => {
		const message = "1 tool call(s) failed: unknown internal shape";

		expect(summarizeClineRecoverableError(message)).toBe(message);
	});

	it("leaves provider errors untouched", () => {
		const message = 'Missing API key for provider "cline".';

		expect(summarizeClineRecoverableError(message)).toBe(message);
	});

	it("leaves already-readable messages untouched", () => {
		const message = "402 Insufficient balance. Your Cline Credits balance is $0.00";

		expect(summarizeClineRecoverableError(message)).toBe(message);
	});
});
