import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { DEFAULT_KANBAN_RUNTIME_PORT, getKanbanRuntimeOrigin } from "../../../src/core/runtime-endpoint";
import { evaluateCors, evaluateHost, getAllowedHostHeaders, handleSocketUpgrade } from "../../../src/server/middleware";

// Arbitrary fixture values for the pure gate functions. `handleSocketUpgrade`
// below exercises the real middleware, so it derives its values from the
// runtime endpoint instead of assuming the default port.
const ALLOWED_ORIGIN = `http://127.0.0.1:${DEFAULT_KANBAN_RUNTIME_PORT}`;
const ALLOWED_HOSTS = new Set([`localhost:${DEFAULT_KANBAN_RUNTIME_PORT}`, `127.0.0.1:${DEFAULT_KANBAN_RUNTIME_PORT}`]);

function firstAllowedHostHeader(): string {
	const [host] = [...getAllowedHostHeaders()];
	if (!host) {
		throw new Error("Expected at least one allowed runtime host header.");
	}
	return host;
}

function makeFakeRequest(headers: Partial<IncomingMessage["headers"]>, method = "GET"): IncomingMessage {
	return { method, headers } as IncomingMessage;
}

describe("evaluateCors", () => {
	it("allows requests with no Origin header", () => {
		const decision = evaluateCors({
			method: "GET",
			originHeader: undefined,
			allowedOrigin: ALLOWED_ORIGIN,
		});
		expect(decision).toEqual({ kind: "allow", origin: null });
	});

	it("allows requests with an empty Origin header", () => {
		const decision = evaluateCors({
			method: "GET",
			originHeader: "",
			allowedOrigin: ALLOWED_ORIGIN,
		});
		expect(decision).toEqual({ kind: "allow", origin: null });
	});

	it("allows requests whose Origin matches the runtime origin", () => {
		const decision = evaluateCors({
			method: "POST",
			originHeader: ALLOWED_ORIGIN,
			allowedOrigin: ALLOWED_ORIGIN,
		});
		expect(decision).toEqual({ kind: "allow", origin: ALLOWED_ORIGIN });
	});

	it("rejects requests from a different origin", () => {
		const decision = evaluateCors({
			method: "POST",
			originHeader: "http://evil.example.com",
			allowedOrigin: ALLOWED_ORIGIN,
		});
		expect(decision).toEqual({ kind: "reject", origin: "http://evil.example.com" });
	});

	it("rejects requests from the same host but a different port", () => {
		const decision = evaluateCors({
			method: "GET",
			originHeader: "http://127.0.0.1:9999",
			allowedOrigin: ALLOWED_ORIGIN,
		});
		expect(decision).toEqual({ kind: "reject", origin: "http://127.0.0.1:9999" });
	});

	it("rejects requests from the same host but a different scheme", () => {
		const decision = evaluateCors({
			method: "GET",
			originHeader: "https://127.0.0.1:3484",
			allowedOrigin: ALLOWED_ORIGIN,
		});
		expect(decision).toEqual({ kind: "reject", origin: "https://127.0.0.1:3484" });
	});

	it("returns a preflight decision for OPTIONS from the allowed origin", () => {
		const decision = evaluateCors({
			method: "OPTIONS",
			originHeader: ALLOWED_ORIGIN,
			allowedOrigin: ALLOWED_ORIGIN,
		});
		expect(decision).toEqual({ kind: "preflight", origin: ALLOWED_ORIGIN });
	});

	it("rejects preflight from a disallowed origin", () => {
		const decision = evaluateCors({
			method: "OPTIONS",
			originHeader: "http://evil.example.com",
			allowedOrigin: ALLOWED_ORIGIN,
		});
		expect(decision).toEqual({ kind: "reject", origin: "http://evil.example.com" });
	});

	it("allows OPTIONS without an Origin header (not a CORS preflight)", () => {
		const decision = evaluateCors({
			method: "OPTIONS",
			originHeader: undefined,
			allowedOrigin: ALLOWED_ORIGIN,
		});
		expect(decision).toEqual({ kind: "allow", origin: null });
	});
});

describe("evaluateHost", () => {
	it("rejects requests with no Host header", () => {
		expect(evaluateHost({ hostHeader: undefined, allowedHosts: ALLOWED_HOSTS })).toEqual({
			kind: "reject",
			host: null,
		});
	});

	it("rejects requests with an empty Host header", () => {
		expect(evaluateHost({ hostHeader: "", allowedHosts: ALLOWED_HOSTS })).toEqual({ kind: "reject", host: null });
	});

	it("allows requests whose Host is in the allowlist", () => {
		expect(evaluateHost({ hostHeader: "127.0.0.1:3484", allowedHosts: ALLOWED_HOSTS })).toEqual({ kind: "allow" });
		expect(evaluateHost({ hostHeader: "localhost:3484", allowedHosts: ALLOWED_HOSTS })).toEqual({ kind: "allow" });
	});

	it("normalises Host header casing before comparing", () => {
		expect(evaluateHost({ hostHeader: "LocalHost:3484", allowedHosts: ALLOWED_HOSTS })).toEqual({ kind: "allow" });
	});

	it("rejects DNS rebinding attempts via a foreign Host header", () => {
		expect(evaluateHost({ hostHeader: "attacker.example.com:3484", allowedHosts: ALLOWED_HOSTS })).toEqual({
			kind: "reject",
			host: "attacker.example.com:3484",
		});
	});

	it("rejects when the port doesn't match", () => {
		expect(evaluateHost({ hostHeader: "localhost:9999", allowedHosts: ALLOWED_HOSTS })).toEqual({
			kind: "reject",
			host: "localhost:9999",
		});
	});
});

describe("handleSocketUpgrade", () => {
	it("passes through upgrades whose Host and Origin are both allowed", () => {
		const socket = new PassThrough();
		const request = makeFakeRequest({
			host: firstAllowedHostHeader(),
			origin: getKanbanRuntimeOrigin(),
		});
		const result = handleSocketUpgrade(request, socket);
		expect(result).toEqual({ end: false });
		expect(socket.destroyed).toBe(false);
	});

	it("rejects upgrades from a disallowed origin with a 403 status line", () => {
		const socket = new PassThrough();
		const written: Buffer[] = [];
		socket.on("data", (chunk) => {
			written.push(chunk as Buffer);
		});
		const request = makeFakeRequest({
			host: firstAllowedHostHeader(),
			origin: "http://evil.example.com",
		});
		const result = handleSocketUpgrade(request, socket);
		expect(result).toEqual({ end: true });
		expect(socket.destroyed).toBe(true);
		expect(Buffer.concat(written).toString("utf8")).toContain("HTTP/1.1 403 Forbidden");
	});

	it("rejects upgrades whose Host header doesn't match the allowlist", () => {
		const socket = new PassThrough();
		const request = makeFakeRequest({
			host: `attacker.example.com:${DEFAULT_KANBAN_RUNTIME_PORT}`,
			origin: getKanbanRuntimeOrigin(),
		});
		const result = handleSocketUpgrade(request, socket);
		expect(result).toEqual({ end: true });
		expect(socket.destroyed).toBe(true);
	});

	it("rejects upgrades with a missing Host header", () => {
		const socket = new PassThrough();
		const request = makeFakeRequest({});
		const result = handleSocketUpgrade(request, socket);
		expect(result).toEqual({ end: true });
		expect(socket.destroyed).toBe(true);
	});
});
