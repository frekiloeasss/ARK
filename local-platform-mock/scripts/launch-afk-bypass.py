"""Launch AFK through Frida while bypassing a stuck libsec bootstrap call.

The Android 12 MuMu image occasionally blocks forever in
JniGoLoad.hello(Context) while translating the ARM64 libsec.so.  This hook is
deliberately narrow: it skips only that Java native call and leaves the APK and
application data untouched.
"""

from __future__ import annotations

import argparse
import threading
import time
from pathlib import Path

import frida
import frida_tools


PACKAGE = "cyou.sharesrc.afk.release146"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1:27042")
    parser.add_argument("--hold-seconds", type=float, default=30.0)
    args = parser.parse_args()

    hit = threading.Event()
    device = frida.get_device_manager().add_remote_device(args.host)
    pid = device.spawn([PACKAGE])
    session = device.attach(pid)

    hook_source = r"""
Java.perform(function () {
    const loader = Java.use('com.example.androidgoso.JniGoLoad');
    const hello = loader.hello.overload('android.content.Context');
    hello.implementation = function (_context) {
        send({ event: 'bypass-hit', method: 'JniGoLoad.hello' });
        return;
    };
    send({ event: 'hook-ready' });
});
"""
    bridge_path = Path(frida_tools.__file__).with_name("bridges") / "java.js"
    source = (
        bridge_path.read_text(encoding="utf-8")
        + "\nObject.defineProperty(globalThis, 'Java', { value: bridge });\n"
        + hook_source
    )

    def on_message(message, _data):
        payload = message.get("payload", {})
        print(payload if payload else message, flush=True)
        if isinstance(payload, dict) and payload.get("event") == "bypass-hit":
            hit.set()

    script = session.create_script(source)
    script.on("message", on_message)
    script.load()
    device.resume(pid)

    hit.wait(args.hold_seconds)
    if hit.is_set():
        # libsec's one-shot bootstrap has returned.  Unload immediately because
        # Frida's mappings can collide with the fixed virtual-address range that
        # the bundled V8 engine reserves moments later.
        time.sleep(0.05)
        script.unload()
        session.detach()

    print({"pid": pid, "bypass_hit": hit.is_set()}, flush=True)
    return 0 if hit.is_set() else 2


if __name__ == "__main__":
    raise SystemExit(main())
