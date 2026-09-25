# Reverse proxy

RigShare works behind a reverse proxy on its own (sub)domain. Two things matter.

## 1. WebSockets

The panel, the live sync and ComfyUI's own progress all run over WebSockets. Without them the panel sits on *Connecting… / Offline*, and the server log says:

```
[RigShare] WebSocket request from … arrived without 'Upgrade: websocket'. If ComfyUI is behind a reverse proxy, enable WebSocket support there
```

**Nginx Proxy Manager**: edit the proxy host and turn on **Websockets Support**.

**nginx**:

```nginx
location / {
    proxy_pass http://comfyui:8188;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400;
    client_max_body_size 500M;
}
```

## 2. HTTPS

Serve it over HTTPS. On plain HTTP, passwords and session cookies cross the network unencrypted. When the proxy sends `X-Forwarded-Proto: https`, the session cookie gets the `Secure` flag automatically.

Once the proxy is in place, stop publishing ComfyUI's port directly, so all traffic goes through HTTPS.

## Sub-paths

RigShare expects to be served at the root of its host (`https://comfy.example.com/`), not under a path like `/comfy/`.

## Trusted IPs behind a proxy

Behind a proxy, every request comes from the proxy's address. Do not add the proxy's IP to the trusted IPs, or everyone would skip the login.
