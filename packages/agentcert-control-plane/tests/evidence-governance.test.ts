import { describe, expect, it } from "vitest";
import {
  ACCEPTED_EVIDENCE_FORMATS,
  EvidenceUploadValidationError,
  validateEvidenceUpload,
} from "../src/evidence-governance.js";

describe("evidence governance", () => {
  it.each([
    ["evidence.png", "image/png", "screenshot", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), "PNG"],
    ["evidence.jpg", "image/jpeg", "screenshot", Buffer.from([0xff, 0xd8, 0xff]), "JPEG"],
    ["evidence.webp", "image/webp", "screenshot", Buffer.from("RIFF0000WEBP"), "WebP"],
    ["evidence.json", "application/json", "json", Buffer.from("{}"), "JSON"],
    ["evidence.jsonl", "application/x-ndjson", "trace", Buffer.from('{}\n{"step":1}'), "JSONL"],
    ["evidence.html", "text/html; charset=utf-8", "report", Buffer.from("<!doctype html><title>Report</title>"), "HTML"],
    ["evidence.pdf", "application/pdf", "report", Buffer.from("%PDF-1.7"), "PDF"],
    ["evidence.zip", "application/zip", "trace", Buffer.from([0x50, 0x4b, 0x03, 0x04]), "ZIP"],
  ])("accepts %s when extension, MIME, kind, and content agree", (fileName, contentType, kind, bytes, format) => {
    expect(validateEvidenceUpload(bytes as Buffer, { fileName, contentType, kind })).toMatchObject({ format });
  });

  it("rejects executables before trusting their name or MIME", () => {
    expect(() => validateEvidenceUpload(Buffer.from("MZpayload"), {
      fileName: "evidence.json", contentType: "application/json", kind: "json",
    })).toThrowError(new EvidenceUploadValidationError("Executable files are not accepted as evidence."));
  });

  it("rejects unsupported extensions, mismatched MIME, kind, and bytes", () => {
    expect(() => validateEvidenceUpload(Buffer.from("text"), {
      fileName: "notes.txt", contentType: "text/plain", kind: "artifact",
    })).toThrow(`Accepted formats: ${ACCEPTED_EVIDENCE_FORMATS.join(", ")}`);
    expect(() => validateEvidenceUpload(Buffer.from("{}"), {
      fileName: "trace.json", contentType: "text/html", kind: "trace",
    })).toThrow("must use application/json");
    expect(() => validateEvidenceUpload(Buffer.from("{}"), {
      fileName: "screenshot.json", contentType: "application/json", kind: "screenshot",
    })).toThrow("does not accept JSON");
    expect(() => validateEvidenceUpload(Buffer.from("not-json"), {
      fileName: "trace.json", contentType: "application/json", kind: "trace",
    })).toThrow("bytes do not match");
  });
});
