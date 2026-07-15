import http from "node:http";

const port = Number(process.env.PORT ?? 3020);

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname === "/refund") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(refundPage());
    return;
  }
  if (url.pathname === "/success") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(successPage());
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Minimal browser-agent demo listening on http://127.0.0.1:${port}`);
});

function refundPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Refund Request</title>
  <style>
    body{margin:0;background:#f7fafc;color:#1e293b;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{max-width:760px;margin:56px auto;padding:0 20px}
    section{background:white;border:1px solid #d6e0ea;border-radius:8px;padding:28px;box-shadow:0 10px 30px rgba(15,23,42,.08)}
    h1{margin:0 0 8px;font-size:30px;letter-spacing:0}.hint{color:#64748b;margin:0 0 24px}
    label{display:block;font-weight:700;margin:16px 0 6px}input,textarea{width:100%;box-sizing:border-box;border:1px solid #b8c4d2;border-radius:6px;padding:10px;font:inherit}
    textarea{min-height:120px}.actions{display:flex;gap:10px;margin-top:20px}
    button{border:0;border-radius:6px;padding:10px 16px;font-weight:800;cursor:pointer}button[type=submit]{background:#0f766e;color:white}button[type=button]{background:#e2e8f0;color:#334155}
  </style>
</head>
<body>
  <main>
    <section aria-labelledby="refund-title">
      <h1 id="refund-title">Refund request</h1>
      <p class="hint">Submit a deterministic localhost refund request.</p>
      <form id="refund-form">
        <label for="order-id">Order ID</label>
        <input id="order-id" name="orderId" autocomplete="off" required>
        <label for="reason">Reason</label>
        <textarea id="reason" name="reason" required></textarea>
        <div class="actions">
          <button type="submit">Submit</button>
          <button type="button" id="cancel">Cancel</button>
        </div>
      </form>
    </section>
  </main>
  <script>
    document.getElementById("refund-form").addEventListener("submit", (event) => {
      event.preventDefault();
      window.location.href = "/success";
    });
    document.getElementById("cancel").addEventListener("click", () => {
      document.getElementById("reason").value = "";
    });
  </script>
</body>
</html>`;
}

function successPage() {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Refund Submitted</title></head>
<body><main><h1>Refund request submitted</h1><p>Your refund request is ready for review.</p></main></body>
</html>`;
}
