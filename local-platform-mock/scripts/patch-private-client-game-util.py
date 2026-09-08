#!/usr/bin/env python3
"""Patch encrypted game_util.jse files to use the public private-server gateway."""

import argparse
import hashlib
import importlib.util
import re
import struct
from pathlib import Path

import lz4.block


P16 = 0x4F8FE476
P17 = 0x29FAE2ED


def load_decrypt_module(script_path: Path):
    spec = importlib.util.spec_from_file_location("afk_decrypt", script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {script_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AfkEncryptor:
    def __init__(self, module, libsec_path: Path):
        binary = libsec_path.read_bytes()
        self.p_words = struct.unpack(
            "<16I",
            b"".join(struct.pack("<Q", value) for value in module.P_WORD_PAIRS),
        )
        self.s_words = struct.unpack(
            "<1024I",
            binary[module.SBOX_FILE_OFFSET : module.SBOX_FILE_OFFSET + 0x1000],
        )

    def f(self, value: int) -> int:
        a = self.s_words[(value >> 24) & 0xFF]
        b = self.s_words[256 + ((value >> 16) & 0xFF)]
        c = self.s_words[512 + ((value >> 8) & 0xFF)]
        d = self.s_words[768 + (value & 0xFF)]
        return ((((a + b) & 0xFFFFFFFF) ^ c) + d) & 0xFFFFFFFF

    def encrypt_block(self, block: bytes) -> bytes:
        if len(block) != 8:
            raise ValueError("Plain block must contain exactly 8 bytes")
        left, right = struct.unpack("<II", block)
        left ^= P16
        for p_word in self.p_words:
            left, right = (self.f(left) ^ right ^ p_word) & 0xFFFFFFFF, left
        return struct.pack("<II", right ^ P17, left)

    def encrypt(self, payload: bytes) -> bytes:
        padded = payload + bytes((-len(payload)) % 8)
        encrypted = b"".join(
            self.encrypt_block(padded[offset : offset + 8])
            for offset in range(0, len(padded), 8)
        )
        return struct.pack("<I", len(payload)) + encrypted


def extract_wrapper(module, decryptor, encrypted: bytes) -> tuple[bytes, bytes]:
    plain_length = struct.unpack_from("<I", encrypted, 0)[0]
    required = module.align_up(plain_length, 8)
    raw = bytearray()
    for offset in range(4, 4 + required, 8):
        raw.extend(decryptor.decrypt_block(encrypted[offset : offset + 8]))
    raw = bytes(raw[:plain_length])
    header_length = struct.unpack_from("<I", raw, 0)[0]
    size_offset = 4 + header_length
    if not (0 < header_length < len(raw) and size_offset + 4 < len(raw)):
        raise ValueError("Expected an LZ4-wrapped Cocos script")
    header = raw[:size_offset]
    unpacked_length = struct.unpack_from("<I", raw, size_offset)[0]
    source = lz4.block.decompress(
        raw[size_offset + 4 :], uncompressed_size=unpacked_length
    )
    return header, source


def patch_script(source: bytes, public_host: str, ws_port: int) -> bytes:
    text = source.decode("utf-8")
    gateway = f"ws://{public_host}:{ws_port}"
    replacement = (
        "getHost:function(){var e=\""
        + gateway
        + '\";return cc.log("sHost "+e),e},setHostNO:function'
    )
    patched, count = re.subn(
        r"getHost:function\(\)\{.*?\},setHostNO:function",
        replacement,
        text,
        count=1,
    )
    if count != 1 and gateway not in text:
        raise RuntimeError("Unable to locate NetHelper.getHost in game_util")

    # The 1.201 settings page still routes its account-center action through
    # switchOrLink().  On the Google Play native SDK this opens the game's
    # classic/team-mode selector and never reaches the SDK login screen.  The
    # newer SDK has a dedicated account switch entry point; use it when it is
    # available and keep the legacy call as a compatibility fallback.
    switch_replacement = (
        "platformSwitchOrLink:function(){window.wx||cc.sys.os==="
        "cc.sys.OS_WINDOWS||(lilithApi.showSwitchAccount?"
        "lilithApi.showSwitchAccount():lilithApi.switchOrLink())},"
        "platformSwitch:function"
    )
    patched, switch_count = re.subn(
        r"platformSwitchOrLink:function\(\)\{.*?\},platformSwitch:function",
        switch_replacement,
        patched,
        count=1,
    )
    if switch_count != 1 and "lilithApi.showSwitchAccount?" not in patched:
        raise RuntimeError("Unable to locate platformSwitchOrLink in game_util")

    # The production client marks most secondary screens as back-download
    # modules.  On a fresh phone that lets the main scene open while those
    # assets are still arriving, so a user can enter Field/Tavern and see an
    # otherwise functional frame with a black scene layer.  Keep the login
    # loader alive until the core gameplay modules are present locally.
    preload_marker = "_afkPrivateCorePreloadDone"
    if preload_marker not in patched:
        preload_start = patched.find("ed.preloadModuleAllRes=function")
        preload_end = patched.find(",ed.ModuleFreeResource=function", preload_start)
        if preload_start < 0 or preload_end < 0:
            raise RuntimeError("Unable to locate ed.preloadModuleAllRes in game_util")
        preload_source = patched[preload_start:preload_end]
        preload_signature = re.search(
            r"ed\.preloadModuleAllRes=function\(([^)]*)\)", preload_source
        )
        if not preload_signature:
            raise RuntimeError("Unable to parse ed.preloadModuleAllRes signature")
        preload_callback = preload_signature.group(1).split(",")[1].strip()
        callback_pattern = (
            r"\(?function\(\)\{" + re.escape(preload_callback)
            + r"&&" + re.escape(preload_callback) + r"\(\)\}\)?"
        )
        callback_replacement = (
            f"function(_afkResult){{{preload_callback}&&"
            f"{preload_callback}(_afkResult)}}"
        )
        preload_source, callback_count = re.subn(
            callback_pattern, callback_replacement, preload_source, count=1
        )
        if callback_count != 1:
            raise RuntimeError("Unable to forward preload result in game_util")
        patched = patched[:preload_start] + preload_source + patched[preload_end:]

        open_module_match = re.search(r"ed\.openModule=function\(([^)]*)\)\{", patched)
        if not open_module_match:
            raise RuntimeError("Unable to locate ed.openModule in game_util")
        open_module_marker = open_module_match.group(0)
        first_argument = open_module_match.group(1).split(",", 1)[0].strip()
        if not first_argument:
            raise RuntimeError("Unable to determine ed.openModule module argument")
        preload_gate = (
            open_module_marker
            + f'var _afkArgs=arguments,_afkName={first_argument};'
            + 'if("map"===_afkName&&cc.sys.jsb&&!ed._afkPrivateCorePreloadDone){'
            + 'if(ed._afkPrivateCorePreloadBusy)return void ed.setTimeout(function(){ed.openModule.apply(ed,_afkArgs)},250);'
            + 'ed._afkPrivateCorePreloadBusy=!0;'
            + 'var _afkQueue=["field","soulBox","dragonTavern","homeland","guild","tower","raid",'
            + '"local_arena","legendArena","hero_package"],_afkIndex=0,_afkRetries={},_afkNext=function(){'
            + 'if(_afkIndex>=_afkQueue.length)return ed._afkPrivateCorePreloadDone=!0,ed._afkPrivateCorePreloadBusy=!1,'
            + 'cc.log("[AFK Private] core resource preload finished"),void ed.openModule.apply(ed,_afkArgs);'
            + 'var _afkCurrent=_afkQueue[_afkIndex++];if(!ed.module_json[_afkCurrent])return void _afkNext();'
            + 'cc.log("[AFK Private] preloading core module: "+_afkCurrent);'
            + 'ed.preloadModuleAllRes(_afkCurrent,function(_afkStatus){'
            + 'if(_afkStatus!==ed.res.success){var _afkRetry=_afkRetries[_afkCurrent]||0;'
            + 'if(_afkRetry<3)return _afkRetries[_afkCurrent]=_afkRetry+1,_afkIndex--,void ed.setTimeout(_afkNext,500);'
            + 'ed._afkPrivateCorePreloadBusy=!1,ed.showToast("核心资源下载失败，正在重试："+_afkCurrent);'
            + 'return void ed.setTimeout(function(){ed.openModule.apply(ed,_afkArgs)},2e3)}_afkNext()})};'
            + 'return cc.log("[AFK Private] core resource preload started"),void _afkNext()}'
        )
        patched = patched.replace(open_module_marker, preload_gate, 1)
    return patched.encode("utf-8")


def patch_boot(
    source: bytes,
    public_host: str,
    ws_port: int,
    resource_port: int,
    default_language: str | None = None,
) -> bytes:
    text = source.decode("utf-8")
    gateway = f"ws://{public_host}:{ws_port}"
    resource_root = f"http://{public_host}:{resource_port}"
    host_block = (
        f'\tcc.game.first_host = "{gateway}";\n'
        f'\tcc.game.second_host = "{gateway}";\n'
        f'\tcc.game.third_host = "{gateway}";'
    )
    patched, host_count = re.subn(
        r"\tcc\.game\.first_host = config\.first_host;\s*"
        r"cc\.game\.second_host = config\.second_host;\s*"
        r"cc\.game\.third_host = config\.third_host;",
        host_block,
        text,
        count=1,
    )
    if host_count != 1 and gateway not in text:
        raise RuntimeError("Unable to locate gateway assignments in jsb_boot")

    cdn_marker = '\tconsole.log("[CDN]: "+ cc.game.cdn);'
    cdn_block = (
        f'\tcc.game.cdn = "{resource_root}";\n'
        "\tcc.game._main_cdn_ = cc.game.cdn;\n"
        '\tcc.game.cdnSubPath = "";\n'
        "\tcc.game.additionalCDNList = [];\n"
        "\tcc.game.retryTotal = 0;\n"
        + cdn_marker
    )
    if resource_root not in patched:
        if cdn_marker not in patched:
            raise RuntimeError("Unable to locate CDN marker in jsb_boot")
        patched = patched.replace(cdn_marker, cdn_block, 1)

    if default_language:
        language_marker = "\tcc.game.sysLang = _getSysLang(config);"
        language_bootstrap = (
            f'\tif (!window.localStorage.getItem("HgameSysLang")) '
            f'window.localStorage.setItem("HgameSysLang", "{default_language}");\n'
            + language_marker
        )
        if language_bootstrap not in patched:
            if language_marker not in patched:
                raise RuntimeError("Unable to locate language initialization")
            patched = patched.replace(language_marker, language_bootstrap, 1)
    return patched.encode("utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets-root", type=Path, required=True)
    parser.add_argument("--libsec", type=Path, required=True)
    parser.add_argument("--public-host", required=True)
    parser.add_argument("--ws-port", type=int, default=15007)
    parser.add_argument("--resource-port", type=int, default=6505)
    parser.add_argument("--default-language")
    args = parser.parse_args()

    module = load_decrypt_module(Path(__file__).with_name("decrypt-afk-config.py"))
    decryptor = module.AfkDecryptor(args.libsec)
    encryptor = AfkEncryptor(module, args.libsec)

    probe = bytes.fromhex("0011223344556677")
    if decryptor.decrypt_block(encryptor.encrypt_block(probe)) != probe:
        raise RuntimeError("Native encryption round-trip validation failed")

    targets = [
        (args.assets_root / "classic" / "srcmodule" / "game_util.jse", patch_script),
        (args.assets_root / "hd" / "srcmodule" / "game_util.jse", patch_script),
        (args.assets_root / "classic" / "script" / "jsb_boot.jse", patch_boot),
        (args.assets_root / "hd" / "script" / "jsb_boot.jse", patch_boot),
    ]
    for target, patcher in targets:
        original = target.read_bytes()
        header, source = extract_wrapper(module, decryptor, original)
        if patcher is patch_boot:
            patched_source = patcher(
                source,
                args.public_host,
                args.ws_port,
                args.resource_port,
                args.default_language,
            )
        else:
            patched_source = patcher(source, args.public_host, args.ws_port)
        compressed = lz4.block.compress(patched_source, store_size=False)
        wrapped = header + struct.pack("<I", len(patched_source)) + compressed
        patched_file = encryptor.encrypt(wrapped)
        target.write_bytes(patched_file)

        verified = decryptor.decrypt(patched_file)
        gateway = f"ws://{args.public_host}:{args.ws_port}".encode()
        if verified != patched_source or gateway not in verified:
            raise RuntimeError(f"Verification failed for {target}")
        digest = hashlib.sha256(patched_file).hexdigest().upper()
        print(f"patched {target} ({len(patched_file)} bytes, sha256 {digest})")


if __name__ == "__main__":
    main()
