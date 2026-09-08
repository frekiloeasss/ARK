"""Invoke the game's native pay method once for a background integration test."""

from __future__ import annotations

import argparse
import threading

import frida
import frida_tools


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1:27042")
    parser.add_argument("--package", default="com.lilithgame.hgame.gp")
    parser.add_argument("--goods-id", type=int, default=987600046)
    parser.add_argument("--product-id", default="com.lilithgame.hgames.package.t5")
    args = parser.parse_args()
    device = frida.get_device_manager().add_remote_device(args.host)
    app = next((row for row in device.enumerate_applications(scope="full") if row.identifier == args.package and row.pid), None)
    if app is None:
        raise RuntimeError("AFK application process is not running")
    session = device.attach(app.pid)
    finished = threading.Event()
    hook = f"""
Java.perform(function () {{
  const Base = Java.use('sdk.ISDKInterface');
  const SDK = Java.use('sdk.SDKInterface');
  const Activity = Java.use('sh.lilithgame.hgame.AppActivity');
  const JSONObject = Java.use('org.json.JSONObject');
  Java.choose('sh.lilithgame.hgame.AppActivity', {{
    onMatch: function (activity) {{
      const instance = Java.cast(Base.getInstance(), SDK);
      const ext = '{{"goodsId":{args.goods_id}}}';
      const pay = SDK.pay.overloads[0];
      if (pay.argumentTypes.length === 4) {{
        pay.call(instance, activity, '{args.product_id}', '', JSONObject.$new(ext));
      }} else {{
        pay.call(instance, activity, '{args.product_id}', ext);
      }}
      send({{event: 'instant-pay-simulated', goods_id: {args.goods_id}}});
      return 'stop';
    }},
    onComplete: function () {{}}
  }});
}});
"""
    bridge_path = __import__("pathlib").Path(frida_tools.__file__).with_name("bridges") / "java.js"
    source = bridge_path.read_text(encoding="utf-8") + "\nObject.defineProperty(globalThis, 'Java', { value: bridge });\n" + hook

    def on_message(message, _data):
        print(message.get("payload", message), flush=True)
        finished.set()

    script = session.create_script(source)
    script.on("message", on_message)
    script.load()
    finished.wait(10)
    script.unload()
    session.detach()
    return 0 if finished.is_set() else 2


if __name__ == "__main__":
    raise SystemExit(main())
