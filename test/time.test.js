import assert from "node:assert/strict";
import test from "node:test";
import { formatCentral } from "../public/time.js";

test("Central time is CDT in September and CST in January", () => {
  assert.equal(formatCentral("2026-09-24T18:00:00Z"), "13:00:00 CDT");
  assert.equal(formatCentral("2026-01-15T18:00:00Z"), "12:00:00 CST");
  assert.equal(formatCentral(""), "");
  assert.equal(formatCentral(undefined), "");
});
