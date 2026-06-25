# MCPBench Quickstart

Run the offline passing example:

```powershell
mcpbench eval --server-command "python examples/servers/github_like_server.py" --suite basic-tool-use --agent scripted --script passing --output-dir .mcpbench/passing
```

Run the offline failing example:

```powershell
mcpbench eval --server-command "python examples/servers/github_like_server.py" --suite untrusted-output --agent scripted --script failing-untrusted-to-sink --output-dir .mcpbench/failing
```

