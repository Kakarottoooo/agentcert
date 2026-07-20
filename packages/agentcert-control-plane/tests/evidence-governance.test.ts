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

  it("validates artifact manifest entries in evidence bundles", () => {
    const sha256 = "a".repeat(64);
    expect(validateEvidenceUpload(Buffer.from(JSON.stringify({
      artifactManifest: {
        schemaVersion: "agentcert.artifact_manifest.v0.1",
        entries: [{ path: "screenshots/step.png", sha256, sizeBytes: 8, kind: "screenshot" }],
      },
    })), { fileName: "evidence.json", contentType: "application/json", kind: "evidence_bundle" })).toMatchObject({
      artifactManifest: { entries: [{ path: "screenshots/step.png", sha256, sizeBytes: 8, kind: "screenshot" }] },
    });

    expect(() => validateEvidenceUpload(Buffer.from(JSON.stringify({
      artifactManifest: {
        schemaVersion: "agentcert.artifact_manifest.v0.1",
        entries: [{ path: "../outside.png", sha256, sizeBytes: 8, kind: "screenshot" }],
      },
    })), { fileName: "evidence.json", contentType: "application/json", kind: "evidence_bundle" })).toThrow("parent segments");
  });

  it("does not count artifact output directories as manifest-reconciled files", () => {
    const bytes = Buffer.from(JSON.stringify({
      artifacts: {
        "tripwire-ci.outDir": ".tripwire/latest",
      },
      results: [{
        artifacts: {
          outDir: ".tripwire/latest",
          result: ".tripwire/latest/tripwire-result.json",
        },
      }],
      artifactManifest: {
        schemaVersion: "agentcert.artifact_manifest.v0.1",
        entries: [{
          path: ".tripwire/latest/tripwire-result.json",
          sha256: "a".repeat(64),
          sizeBytes: 2,
          kind: "json",
        }],
      },
    }));

    expect(validateEvidenceUpload(bytes, {
      fileName: "evidence.json", contentType: "application/json", kind: "evidence_bundle",
    })).toMatchObject({ artifactReferenceCount: 1 });
  });

  it("extracts declared source evidence strength for hosted assurance reports", () => {
    const result = validateEvidenceUpload(Buffer.from(JSON.stringify({
      evidenceStrength: {
        schemaVersion: "agentcert.evidence_strength.v0.1",
        level: "outcome_verified",
        claims: ["A separate read path observed the expected state."],
        limitations: ["Future behavior is not guaranteed."],
      },
    })), { fileName: "evidence.json", contentType: "application/json", kind: "evidence_bundle" });
    expect(result.evidenceStrength).toMatchObject({ level: "outcome_verified" });
  });
});
