"""Keep the AFK native payment entry in local instant-grant mode.

The bridge attaches after the game's V8 runtime is initialized, intercepts only
sdk.SDKInterface.pay(Activity, productId, ext), fulfills the matching recovered
Charge/ChargeGoods row through the local server, and reports success to the
existing SDKObserver. No store UI or real-money provider is contacted.
"""

from __future__ import annotations

import argparse
import json
import threading
import time
import urllib.error
import urllib.request

import frida
import frida_tools


PACKAGE = "cyou.sharesrc.afk.release146"


HOOK = r"""
Java.perform(function () {
  const SDK = Java.use('sdk.SDKInterface');

  function awaitResult() {
    recv('purchase-result', function (message) {
      const payload = message.payload || {};
      Java.perform(function () {
        try {
          const Base = Java.use('sdk.ISDKInterface');
          const ObserverBase = Java.use('sdk.Observer');
          const SDKObserver = Java.use('com.lilith.sdk.SDKObserver');
          const PayType = Java.use('com.lilith.sdk.common.constant.PayType');
          const instance = Base.getInstance();
          const field = ObserverBase.class.getDeclaredField('mObserver');
          field.setAccessible(true);
          const observer = Java.cast(field.get(instance), SDKObserver);
          const payTypes = PayType.values();
          const payType = payTypes.length ? payTypes[0] : null;
          const success = !!payload.ok;
          observer.onPayFinish.overload(
            'boolean', 'int', 'int', 'java.lang.String',
            'com.lilith.sdk.common.constant.PayType'
          ).call(observer, success, success ? 0 : -1, 0, String(payload.product_id || ''), payType);
          send({event: 'instant-pay-callback', ok: success, order_id: payload.order_id || null});
        } catch (error) {
          send({event: 'instant-pay-callback-error', error: String(error), payload: payload});
        }
      });
      awaitResult();
    });
  }

  SDK.pay.overloads.forEach(function (pay) {
    pay.implementation = function () {
      const productId = arguments.length > 1 ? String(arguments[1] || '') : '';
      let ext = '';
      for (let index = 2; index < arguments.length; index += 1) {
        const value = arguments[index];
        if (value === null || value === undefined) continue;
        const candidate = String(value);
        if (!ext || candidate.trim().startsWith('{') || candidate.trim().startsWith('[')) ext = candidate;
      }
      send({event: 'instant-pay-request', product_id: productId, ext: ext});
      return;
    };
  });
  awaitResult();
  const Observer = Java.use('com.lilith.sdk.SDKObserver');
  send({
    event: 'instant-pay-hook-ready',
    pay_signatures: SDK.pay.overloads.map(function (row) {
      return row.argumentTypes.map(function (type) { return type.className; });
    }),
    callback_signatures: Observer.onPayFinish.overloads.map(function (row) {
      return row.argumentTypes.map(function (type) { return type.className; });
    })
  });
});
"""


def post_purchase(base_url: str, product_id: str, ext: str) -> dict:
    payload: dict = {"product_id": product_id, "ext": ext, "idempotency_key": f"native:{time.time_ns()}:{product_id}"}
    try:
        decoded = json.loads(ext) if ext else {}
    except json.JSONDecodeError:
        decoded = {}
    if isinstance(decoded, dict):
        for key in ("goods_id", "goodsId", "GoodsID", "goodsid", "item_id", "itemId"):
            value = decoded.get(key)
            if str(value or "").isdigit():
                payload["goods_id"] = int(value)
                break
    if "goods_id" not in payload and str(ext).strip().isdigit():
        payload["goods_id"] = int(str(ext).strip())
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/__afk/payments/purchase",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        return {"ok": False, "error": repr(error), "product_id": product_id}
    result["product_id"] = product_id
    return result


def application_pid(device, package: str) -> int:
    for app in device.enumerate_applications(scope="full"):
        if app.identifier == package and app.pid:
            return int(app.pid)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1:27042")
    parser.add_argument("--base-url", default="http://127.0.0.1:18080")
    parser.add_argument("--package", default=PACKAGE)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    bridge_path = __import__("pathlib").Path(frida_tools.__file__).with_name("bridges") / "java.js"
    source = bridge_path.read_text(encoding="utf-8") + "\nObject.defineProperty(globalThis, 'Java', { value: bridge });\n" + HOOK
    manager = frida.get_device_manager()
    device = None

    while True:
        detached = threading.Event()
        try:
            if device is None:
                device = manager.add_remote_device(args.host)
            pid = application_pid(device, args.package)
            if not pid:
                if args.once:
                    return 2
                time.sleep(2)
                continue
            session = device.attach(pid)
            script = session.create_script(source)

            def on_message(message, _data):
                payload = message.get("payload", message)
                print(json.dumps(payload, ensure_ascii=False), flush=True)
                if isinstance(payload, dict) and payload.get("event") == "instant-pay-request":
                    result = post_purchase(args.base_url, str(payload.get("product_id") or ""), str(payload.get("ext") or ""))
                    script.post({"type": "purchase-result", "payload": result})

            session.on("detached", lambda *_args: detached.set())
            script.on("message", on_message)
            script.load()
            if args.once:
                time.sleep(1)
                script.unload()
                session.detach()
                return 0
            detached.wait()
        except Exception as error:
            print(json.dumps({"event": "instant-pay-bridge-error", "error": repr(error)}), flush=True)
            # Emulator restarts and ADB forward refreshes invalidate Frida's
            # remote transport. Recreate it instead of terminating the bridge.
            try:
                manager.remove_remote_device(args.host)
            except Exception:
                pass
            device = None
            if args.once:
                return 3
        time.sleep(2)


if __name__ == "__main__":
    raise SystemExit(main())
