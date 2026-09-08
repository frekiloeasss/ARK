from __future__ import annotations

import argparse
import json
import threading

import frida
import frida_tools


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1:27042")
    parser.add_argument("--package", default="cyou.sharesrc.afk.release146")
    args = parser.parse_args()
    device = frida.get_device_manager().add_remote_device(args.host)
    target = int(args.package) if str(args.package).isdigit() else args.package
    session = device.attach(target)
    finished = threading.Event()
    hook = r"""
Java.perform(function () {
  const names = Java.enumerateLoadedClassesSync().filter(function (name) {
    return name === 'sdk.SDKInterface' || name === 'sdk.ISDKInterface' || name === 'sdk.Observer' || name === 'com.lilith.sdk.SDKObserver' || name.indexOf('HgameInterface') >= 0;
  });
  const result = [];
  names.forEach(function (name) {
    try {
      const klass = Java.use(name).class;
      result.push({name: name, superclass: String(klass.getSuperclass()), fields: klass.getDeclaredFields().map(function (field) { return field.toString(); }), methods: klass.getDeclaredMethods().map(function (method) { return method.toString(); })});
    } catch (error) { result.push({name: name, error: String(error)}); }
  });
  send({event: 'sdk-inventory', classes: result});
});
"""
    bridge_path = __import__("pathlib").Path(frida_tools.__file__).with_name("bridges") / "java.js"
    source = bridge_path.read_text(encoding="utf-8") + "\nObject.defineProperty(globalThis, 'Java', { value: bridge });\n" + hook

    def on_message(message, _data):
        print(json.dumps(message.get("payload", message), ensure_ascii=False, indent=2), flush=True)
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
