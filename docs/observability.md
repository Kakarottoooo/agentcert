# Observability

The first stable observability artifact is `events.jsonl`.

Each event includes:

- event id;
- run id;
- task id;
- timestamp;
- event type;
- span id;
- parent span id;
- sequence index;
- actor;
- data payload;
- redaction metadata;
- schema version.

Future exporters will map events into OpenTelemetry spans and OpenInference-compatible attributes. Redaction helpers preserve benign canaries while redacting suspicious key names such as `api_key`, `secret`, and `token`.

