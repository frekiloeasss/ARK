import os

from mitmproxy import ctx
from mitmproxy import http
from mitmproxy.proxy import server_hooks

TARGET_HOSTS = {
    "account-global.lilith.com",
    "app.lilithgame.com",
    "app-global.lilithgame.com",
    "app-global-1.lilithgame.com",
    "app-global-2.lilithgame.com",
    "34.149.80.225",
    "park-m-global.lilith.com",
    "plat-conf-gl.lilithgame.com",
    "psp-api.lilithgame.com",
    "mock-client-sdk.mock.invalid",
    "f.l01.sharesrc.cyou",
    "graph.facebook.com",
}

TARGET_HOST_SUFFIXES = (
    ".app.lilithgame.com",
)


def should_route_host(host: str) -> bool:
    normalized = str(host or "").lower()
    extra_hosts = {
        value.strip().lower()
        for value in os.environ.get("AFK_EXTRA_ROUTE_HOSTS", "").split(",")
        if value.strip()
    }
    return normalized in (TARGET_HOSTS | extra_hosts) or any(
        normalized.endswith(suffix) for suffix in TARGET_HOST_SUFFIXES
    )


def rewrite_flow_to_mock(flow: http.HTTPFlow) -> None:
    mock_host = connectable_mock_host()
    mock_port = ctx.options.afk_mock_port
    original_host = flow.request.pretty_host

    flow.request.headers["x-afk-original-host"] = original_host
    flow.request.headers["x-afk-original-scheme"] = flow.request.scheme
    flow.request.headers["x-afk-original-url"] = flow.request.pretty_url
    flow.request.headers["host"] = f"{mock_host}:{mock_port}"
    flow.request.scheme = "http"
    flow.request.host = mock_host
    flow.request.port = mock_port

    ctx.log.info(
        f"rewrote {original_host.lower()} -> {mock_host}:{mock_port} "
        f"{flow.request.method} {flow.request.path}"
    )


def load(loader):
    loader.add_option(
        "afk_mock_host",
        str,
        "127.0.0.1",
        "Host of the local AFK platform mock service.",
    )
    loader.add_option(
        "afk_mock_port",
        int,
        18080,
        "Port of the local AFK platform mock service.",
    )
    loader.add_option(
        "afk_mock_https_port",
        int,
        18443,
        "TLS port of the local AFK platform mock service.",
    )
    ctx.log.info(
        "Routing Lilith platform hosts to local mock "
        f"http://{ctx.options.afk_mock_host}:{ctx.options.afk_mock_port}"
    )


def requestheaders(flow: http.HTTPFlow) -> None:
    host = flow.request.pretty_host.lower()
    if not should_route_host(host):
        return

    rewrite_flow_to_mock(flow)


def request(flow: http.HTTPFlow) -> None:
    host = flow.request.pretty_host.lower()
    if not should_route_host(host):
        return

    rewrite_flow_to_mock(flow)


def server_connect(data: server_hooks.ServerConnectionHookData) -> None:
    if not data.server.address:
        return

    host, _port = data.server.address
    if not should_route_host(host):
        return

    mock_host = connectable_mock_host()
    mock_port = (
        ctx.options.afk_mock_https_port
        if bool(getattr(data.server, "tls", False))
        else ctx.options.afk_mock_port
    )
    data.server.address = (mock_host, mock_port)

    ctx.log.info(
        f"rerouted upstream server {str(host).lower()} -> {mock_host}:{mock_port} "
        f"tls={'on' if bool(getattr(data.server, 'tls', False)) else 'off'}"
    )


def connectable_mock_host() -> str:
    host = str(ctx.options.afk_mock_host or "127.0.0.1")
    return "127.0.0.1" if host in ("0.0.0.0", "::") else host
