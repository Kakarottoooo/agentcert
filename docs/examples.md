# Examples

Inspect the synthetic GitHub-like registry:

```powershell
mcpbench inspect --server-command "python examples/servers/github_like_server.py" --output out/inspect.json
```

Run a passing trace:

```powershell
mcpbench eval --suite basic-tool-use --agent scripted --script passing --output-dir .mcpbench/passing
```

Run a failing trace:

```powershell
mcpbench eval --suite untrusted-output --agent scripted --script failing-untrusted-to-sink --output-dir .mcpbench/failing
```

