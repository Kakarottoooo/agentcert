from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any


class AgentCertError(RuntimeError):
    pass


@dataclass(frozen=True)
class AgentCertClient:
    base_url: str
    project_id: str
    api_key: str
    timeout: float = 30.0

    def start_run(self, **input: Any) -> dict[str, Any]:
        return self._json("runs", method="POST", body=input)

    def append_events(self, run_id: str, events: list[dict[str, Any]]) -> dict[str, Any]:
        return self._json(
            f"runs/{urllib.parse.quote(run_id)}/events", method="POST", body={"events": events}
        )

    def complete_run(self, run_id: str, **input: Any) -> dict[str, Any]:
        return self._json(f"runs/{urllib.parse.quote(run_id)}/complete", method="POST", body=input)

    def assess_action(self, **input: Any) -> dict[str, Any]:
        return self._json("actions", method="POST", body=input)

    def send_envelope(self, envelope: dict[str, Any]) -> dict[str, Any]:
        envelope_id = str(envelope.get("envelopeId") or "")
        if not envelope_id:
            raise AgentCertError("envelopeId is required")
        return self._json(
            "envelopes",
            method="POST",
            body=envelope,
            headers={"Idempotency-Key": envelope_id},
        )

    def get_action(self, action_id: str) -> dict[str, Any]:
        return self._json(f"actions/{urllib.parse.quote(action_id)}")

    def verify_action(self, action_id: str, observed_state: dict[str, Any]) -> dict[str, Any]:
        return self._json(
            f"actions/{urllib.parse.quote(action_id)}/verify",
            method="POST",
            body={"observedState": observed_state},
        )

    def upload_evidence(
        self,
        content: bytes,
        file_name: str,
        *,
        content_type: str = "application/octet-stream",
        kind: str = "artifact",
        schema_version: str = "agentcert.evidence.v0.1",
        run_id: str | None = None,
        action_id: str | None = None,
        source_path: str | None = None,
    ) -> dict[str, Any]:
        query = {"fileName": file_name, "kind": kind, "schemaVersion": schema_version}
        if run_id:
            query["runId"] = run_id
        if action_id:
            query["actionId"] = action_id
        if source_path:
            query["sourcePath"] = source_path
        return self._request(
            f"evidence?{urllib.parse.urlencode(query)}",
            method="POST",
            content=content,
            content_type=content_type,
        )

    def _json(
        self, suffix: str, *, method: str = "GET", body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        content = json.dumps(body).encode("utf-8") if body is not None else None
        return self._request(
            suffix, method=method, content=content, content_type="application/json", headers=headers
        )

    def _request(
        self, suffix: str, *, method: str, content: bytes | None, content_type: str,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        if not self.base_url or not self.project_id or not self.api_key:
            raise AgentCertError("base_url, project_id, and api_key are required")
        url = f"{self.base_url.rstrip('/')}/v1/projects/{urllib.parse.quote(self.project_id)}/{suffix}"
        request = urllib.request.Request(
            url,
            data=content,
            method=method,
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": content_type, **(headers or {})},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            payload = error.read().decode("utf-8")
            try:
                message = json.loads(payload).get("error", payload)
            except json.JSONDecodeError:
                message = payload
            raise AgentCertError(
                f"AgentCert API request failed ({error.code}): {message}"
            ) from error
