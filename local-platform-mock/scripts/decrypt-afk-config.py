#!/usr/bin/env python3
"""Decrypt AFK Arena .jsone/.protoe files with the client v1.182 native routine."""

import argparse
import struct
from pathlib import Path

from unicorn import Uc, UC_ARCH_ARM64, UC_MODE_ARM
from unicorn.arm64_const import (
    UC_ARM64_REG_PC,
    UC_ARM64_REG_SP,
    UC_ARM64_REG_X0,
    UC_ARM64_REG_X1,
    UC_ARM64_REG_X28,
    UC_ARM64_REG_X30,
)
import lz4.block


TEXT_VA = 0x34DC70
TEXT_FILE_OFFSET = 0x34CC70
TEXT_SIZE = 0x85D2D4
DECRYPT_BLOCK_VA = 0x515230
SBOX_FILE_OFFSET = 0x320DF0
P_WORD_PAIRS = (
    0x6E18CCCFB83223D2,
    0x82287E478271249F,
    0xC6BCA3389AD35DF4,
    0x9F3C52F1D2A1B734,
    0x8D65DA1EFE106710,
    0xE71CD23FC22AE813,
    0xC19F2539F94B393B,
    0x04EF0702830BBFB8,
)


def align_down(value: int, alignment: int = 0x1000) -> int:
    return value & ~(alignment - 1)


def align_up(value: int, alignment: int = 0x1000) -> int:
    return (value + alignment - 1) & ~(alignment - 1)


class AfkDecryptor:
    def __init__(self, libsec_path: Path):
        binary = libsec_path.read_bytes()
        self.uc = Uc(UC_ARCH_ARM64, UC_MODE_ARM)

        text_base = align_down(TEXT_VA)
        text_end = align_up(TEXT_VA + TEXT_SIZE)
        self.uc.mem_map(text_base, text_end - text_base)
        self.uc.mem_write(TEXT_VA, binary[TEXT_FILE_OFFSET : TEXT_FILE_OFFSET + TEXT_SIZE])

        self.globals_va = 0x130C000
        self.uc.mem_map(self.globals_va, 0x2000)
        self.tables_va = 0x02000000
        self.uc.mem_map(self.tables_va, 0x4000)
        p_data = b"".join(struct.pack("<Q", value) for value in P_WORD_PAIRS)
        s_data = binary[SBOX_FILE_OFFSET : SBOX_FILE_OFFSET + 0x1000]
        self.uc.mem_write(self.tables_va, p_data)
        self.uc.mem_write(self.tables_va + 0x1000, s_data)
        self.uc.mem_write(0x130CD30, struct.pack("<Q", self.tables_va))
        self.uc.mem_write(0x130CD38, struct.pack("<Q", 16))
        self.uc.mem_write(0x130CD50, struct.pack("<Q", self.tables_va + 0x1000))
        self.uc.mem_write(0x130CD58, struct.pack("<Q", 0x1000))

        self.stack_va = 0x04000000
        self.uc.mem_map(self.stack_va, 0x10000)
        self.g_va = 0x05000000
        self.uc.mem_map(self.g_va, 0x1000)
        self.uc.mem_write(self.g_va + 0x10, struct.pack("<Q", self.stack_va + 0x1000))
        self.data_va = 0x06000000
        self.uc.mem_map(self.data_va, 0x1000)
        self.return_va = 0x07000000
        self.uc.mem_map(self.return_va, 0x1000)
        self.uc.mem_write(self.return_va, b"\x1f\x20\x03\xd5")

    def decrypt_block(self, block: bytes) -> bytes:
        if len(block) != 8:
            raise ValueError("Encrypted block must contain exactly 8 bytes")
        self.uc.mem_write(self.data_va, block)
        self.uc.reg_write(UC_ARM64_REG_SP, self.stack_va + 0xF000)
        self.uc.reg_write(UC_ARM64_REG_X28, self.g_va)
        self.uc.reg_write(UC_ARM64_REG_X0, self.data_va)
        self.uc.reg_write(UC_ARM64_REG_X1, self.data_va + 4)
        self.uc.reg_write(UC_ARM64_REG_X30, self.return_va)
        self.uc.reg_write(UC_ARM64_REG_PC, DECRYPT_BLOCK_VA)
        self.uc.emu_start(DECRYPT_BLOCK_VA, self.return_va)
        return bytes(self.uc.mem_read(self.data_va, 8))

    def decrypt(self, payload: bytes) -> bytes:
        if len(payload) < 4:
            raise ValueError("Encrypted file is shorter than its length header")
        plain_length = struct.unpack_from("<I", payload, 0)[0]
        encrypted = payload[4:]
        required = align_up(plain_length, 8)
        if len(encrypted) < required:
            raise ValueError(f"Need {required} encrypted bytes, got {len(encrypted)}")
        output = bytearray()
        for offset in range(0, required, 8):
            output.extend(self.decrypt_block(encrypted[offset : offset + 8]))
        decrypted = bytes(output[:plain_length])
        if len(decrypted) >= 12:
            header_length = struct.unpack_from("<I", decrypted, 0)[0]
            size_offset = 4 + header_length
            if 0 < header_length < len(decrypted) and size_offset + 4 < len(decrypted):
                unpacked_length = struct.unpack_from("<I", decrypted, size_offset)[0]
                compressed = decrypted[size_offset + 4 :]
                try:
                    return lz4.block.decompress(
                        compressed, uncompressed_size=unpacked_length
                    )
                except lz4.block.LZ4BlockError:
                    pass
        return decrypted


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--libsec", type=Path, required=True)
    args = parser.parse_args()
    decrypted = AfkDecryptor(args.libsec).decrypt(args.input.read_bytes())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(decrypted)
    print(f"decrypted {args.input} -> {args.output} ({len(decrypted)} bytes)")


if __name__ == "__main__":
    main()
