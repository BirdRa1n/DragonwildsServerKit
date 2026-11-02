"""Minimal reader for Unreal IoStore containers (.utoc/.ucas), version 8, uncompressed and unencrypted.

Files are looked up by path through the container's directory index. Compressed or encrypted containers
are refused rather than misread.
"""
import struct

HEADER_SIZE = 144
FLAG_ENCRYPTED = 2
FLAG_SIGNED = 4


class IoStore:
    def __init__(self, base):
        self.ucas = open(base + ".ucas", "rb")
        with open(base + ".utoc", "rb") as f:
            toc = f.read()
        if toc[:16] != b"-==--==--==--==-" or toc[16] != 8:
            raise ValueError("unsupported .utoc version")
        (self.entries, block_count, block_size, method_count, method_len, self.block_bytes, dir_size) = struct.unpack_from("<IIIIIII", toc, 24)
        flags = toc[80]
        if method_count != 0 or flags & FLAG_ENCRYPTED:
            raise ValueError(f"container is compressed or encrypted (methods={method_count}, flags={flags})")
        seeds, = struct.unpack_from("<I", toc, 84)
        no_hash, = struct.unpack_from("<I", toc, 96)
        pos = HEADER_SIZE
        self.chunk_ids = pos
        pos += self.entries * 12
        self.offset_lengths = pos
        pos += self.entries * 10
        pos += seeds * 4 + no_hash * 4
        self.blocks = pos
        pos += block_count * block_size
        pos += method_count * method_len
        if flags & FLAG_SIGNED:
            sig, = struct.unpack_from("<I", toc, pos)
            pos += 4 + 2 * sig + block_count * 20
        self.toc = toc
        self.files = self._read_directory(pos, dir_size)

    def _read_directory(self, pos, size):
        toc = self.toc
        end = pos + size

        def read_string(p):
            n, = struct.unpack_from("<i", toc, p)
            p += 4
            if n < 0:
                raw = toc[p:p - 2 * n]
                return raw[:-2].decode("utf-16-le"), p - 2 * n
            return toc[p:p + n - 1].decode("utf-8", "replace") if n else "", p + n

        mount, pos = read_string(pos)
        count, = struct.unpack_from("<i", toc, pos)
        pos += 4
        dirs = struct.unpack_from(f"<{count * 4}I", toc, pos)
        pos += count * 16
        count_f, = struct.unpack_from("<i", toc, pos)
        pos += 4
        files = struct.unpack_from(f"<{count_f * 3}I", toc, pos)
        pos += count_f * 12
        count_s, = struct.unpack_from("<i", toc, pos)
        pos += 4
        names = []
        for _ in range(count_s):
            s, pos = read_string(pos)
            names.append(s)
        assert pos <= end

        NONE = 0xFFFFFFFF
        out = {}
        stack = [(0, mount.rstrip("/"))]
        while stack:
            d, prefix = stack.pop()
            name, child, sibling, first_file = dirs[d * 4:d * 4 + 4]
            path = prefix if name == NONE else f"{prefix}/{names[name]}"
            f = first_file
            while f != NONE:
                fname, next_file, user = files[f * 3:f * 3 + 3]
                out[f"{path}/{names[fname]}"] = user
                f = next_file
            if child != NONE:
                stack.append((child, path))
            if sibling != NONE:
                stack.append((sibling, prefix))
        return out

    def read_entry(self, index):
        raw = self.toc[self.offset_lengths + index * 10:self.offset_lengths + index * 10 + 10]
        offset = int.from_bytes(raw[:5], "big")
        length = int.from_bytes(raw[5:], "big")
        out = bytearray()
        block = offset // self.block_bytes
        skip = offset % self.block_bytes
        while len(out) < length:
            b = self.toc[self.blocks + block * 12:self.blocks + block * 12 + 12]
            at = int.from_bytes(b[:5], "little")
            size = int.from_bytes(b[5:8], "little")
            self.ucas.seek(at + skip)
            out += self.ucas.read(size - skip)
            skip = 0
            block += 1
        return bytes(out[:length])

    def read_file(self, path):
        return self.read_entry(self.files[path])
