#!/usr/bin/env python3
import argparse, importlib.util
from pathlib import Path

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

p = argparse.ArgumentParser()
p.add_argument("file", type=Path)
p.add_argument("marker")
p.add_argument("--libsec", type=Path, required=True)
p.add_argument("--radius", type=int, default=500)
a = p.parse_args()
s = Path(__file__).resolve().parent
dmod = load("afk_decrypt", s / "decrypt-afk-config.py")
pmod = load("afk_patch", s / "patch-private-client-game-util.py")
d = dmod.AfkDecryptor(a.libsec)
_, body = pmod.extract_wrapper(dmod, d, a.file.read_bytes())
text = body.decode("utf-8")
start = count = 0
while True:
    idx = text.find(a.marker, start)
    if idx < 0: break
    count += 1
    print(f"\n--- match {count} at {idx} ---\n{text[max(0,idx-a.radius):idx+len(a.marker)+a.radius]}")
    start = idx + len(a.marker)
print(f"\nmatches={count}")
