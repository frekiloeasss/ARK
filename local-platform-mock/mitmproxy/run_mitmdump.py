import sys

from mitmproxy.tools.main import mitmdump


if __name__ == "__main__":
    raise SystemExit(mitmdump(sys.argv[1:]) or 0)
