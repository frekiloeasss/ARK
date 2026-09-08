"""Replace an equal-length ASCII string in a running AFK process, then detach.

This is used for one-shot runtime compatibility patches after the ARM64 startup
bridge has finished. Detaching immediately avoids keeping a Frida V8 runtime in
the translated game process.
"""

import argparse
import json
import sys
import time

import frida


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("expected")
    parser.add_argument("replacement")
    parser.add_argument("--host", default="127.0.0.1:27042")
    parser.add_argument("--package", default="cyou.sharesrc.afk.release146")
    args = parser.parse_args()
    if len(args.expected) != len(args.replacement):
        parser.error("expected and replacement must have equal length")

    device = frida.get_device_manager().add_remote_device(args.host)
    process = next(
        (
            item
            for item in device.enumerate_processes()
            if item.name == args.package or item.name.lower() == "afkdragon"
        ),
        None,
    )
    if process is None:
        raise RuntimeError(f"process not running: {args.package}")

    session = device.attach(process.pid)
    source = """
    const expected = %s;
    const replacement = %s;
    let matches = 0;
    for (const range of Process.enumerateRanges('r--').concat(Process.enumerateRanges('rw-'))) {
      try {
        for (const match of Memory.scanSync(range.base, range.size, expected)) {
          Memory.protect(match.address, replacement.length, 'rw-');
          match.address.writeByteArray(replacement);
          matches++;
        }
      } catch (_) {
        // Some translated ARM64 mappings are listed as readable before the
        // native bridge makes every page accessible. Skip those sparse ranges.
      }
    }
    send({ event: 'patched', matches });
    """ % (json.dumps(args.expected.encode().hex().replace("", " ").strip()),
           json.dumps(list(args.replacement.encode())))
    # Frida's scan pattern needs spaced byte pairs, not spaced characters.
    pattern = " ".join(f"{byte:02x}" for byte in args.expected.encode())
    source = source.replace(json.dumps(args.expected.encode().hex().replace("", " ").strip()), json.dumps(pattern))

    messages = []
    script = session.create_script(source)
    script.on("message", lambda message, data: messages.append(message))
    script.load()
    deadline = time.time() + 5
    while not messages and time.time() < deadline:
        time.sleep(0.05)
    script.unload()
    session.detach()
    if not messages:
        raise RuntimeError("runtime patch timed out")
    if messages[-1].get("type") == "error":
        print(messages[-1])
        return 1
    payload = messages[-1].get("payload", {})
    print(payload)
    return 0 if payload.get("matches", 0) else 2


if __name__ == "__main__":
    sys.exit(main())
