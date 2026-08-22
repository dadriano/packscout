import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hostnameFromHostHeader,
  isLoopbackHostHeader,
  isLoopbackHostname,
  isLoopbackOrigin,
} from "./loopback.ts";

test("loopback hostnames are recognized in every local form", () => {
  for (const value of [
    "localhost",
    "LOCALHOST",
    "127.0.0.1",
    "127.1.2.3",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
  ]) {
    assert.equal(isLoopbackHostname(value), true, value);
  }
});

test("non-loopback hostnames are rejected", () => {
  for (const value of [
    "",
    "example.com",
    "127.0.0.1.evil.com",
    "0.0.0.0",
    "192.168.1.10",
    "localhost.evil.com",
    "127.0.0.999",
    "::2",
    null,
    undefined,
    17,
  ]) {
    assert.equal(isLoopbackHostname(value), false, String(value));
  }
});

test("host headers drop the port before the loopback check", () => {
  assert.equal(hostnameFromHostHeader("127.0.0.1:5110"), "127.0.0.1");
  assert.equal(hostnameFromHostHeader("[::1]:5110"), "[::1]");
  assert.equal(hostnameFromHostHeader("localhost"), "localhost");
  assert.equal(hostnameFromHostHeader("[::1"), null);
  assert.equal(hostnameFromHostHeader(""), null);
  assert.equal(hostnameFromHostHeader(undefined), null);
});

test("a rebound host header fails closed", () => {
  assert.equal(isLoopbackHostHeader("127.0.0.1:5110"), true);
  assert.equal(isLoopbackHostHeader("localhost:5110"), true);
  assert.equal(isLoopbackHostHeader("[::1]:5110"), true);
  assert.equal(isLoopbackHostHeader("panel.attacker.example:5110"), false);
  assert.equal(isLoopbackHostHeader(undefined), false);
});

test("only loopback http origins are accepted", () => {
  assert.equal(isLoopbackOrigin("http://127.0.0.1:5110"), true);
  assert.equal(isLoopbackOrigin("http://localhost:5110"), true);
  assert.equal(isLoopbackOrigin("http://[::1]:5110"), true);
  assert.equal(isLoopbackOrigin("https://localhost"), true);
  assert.equal(isLoopbackOrigin("https://attacker.example"), false);
  assert.equal(isLoopbackOrigin("null"), false);
  assert.equal(isLoopbackOrigin("file://"), false);
  assert.equal(isLoopbackOrigin("not a url"), false);
  assert.equal(isLoopbackOrigin(undefined), false);
});
