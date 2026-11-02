"""Readers for the game's translations: a version 11 .pak archive and the .locres files inside it.

Only uncompressed, unencrypted files can be read. Anything else is refused rather than misread.
"""
import struct

PAK_MAGIC = 0x5A6F12E1
ENTRY_HEADER_SIZE = 53  # offset, sizes, method, hash, flags and block size, stored before each file
LOCRES_MAGIC = bytes([0x0E, 0x14, 0x74, 0x75, 0x67, 0x4A, 0x03, 0xFC, 0x4A, 0x15, 0x90, 0x9D, 0xC3, 0x37, 0x7F, 0x1B])


class Reader:
    def __init__(self, data, pos=0):
        self.data = data
        self.pos = pos

    def unpack(self, fmt):
        values = struct.unpack_from("<" + fmt, self.data, self.pos)
        self.pos += struct.calcsize("<" + fmt)
        return values[0] if len(values) == 1 else values

    def string(self):
        n = self.unpack("i")
        if n == 0:
            return ""
        if n < 0:
            raw = self.data[self.pos:self.pos - 2 * n]
            self.pos -= 2 * n
            return raw[:-2].decode("utf-16-le", "replace")
        raw = self.data[self.pos:self.pos + n]
        self.pos += n
        return raw[:-1].decode("utf-8", "replace")

    def skip(self, n):
        self.pos += n


class Pak:
    def __init__(self, path):
        self.file = open(path, "rb")
        self.file.seek(0, 2)
        size = self.file.tell()
        self.file.seek(size - 204)
        footer = self.file.read(204)
        at = footer.find(struct.pack("<I", PAK_MAGIC))
        if at < 0:
            raise ValueError("not a supported .pak archive")
        version, index_offset, index_size = struct.unpack_from("<Iqq", footer, at + 4)
        if version != 11:
            raise ValueError(f"unsupported .pak version {version}")
        if footer[at - 1]:
            raise ValueError("encrypted .pak index")
        self.file.seek(index_offset)
        self.files = self._read_index(Reader(self.file.read(index_size)))

    def _read_index(self, r):
        mount = r.string()
        r.skip(4 + 8)  # entry count, path hash seed
        if r.unpack("i"):
            r.skip(8 + 8 + 20)  # path hash index
        if not r.unpack("i"):
            raise ValueError("no directory index in .pak")
        dir_offset, dir_size = r.unpack("qq")
        r.skip(20)
        length = r.unpack("i")
        encoded = r.data[r.pos:r.pos + length]

        self.file.seek(dir_offset)
        d = Reader(self.file.read(dir_size))
        files = {}
        for _ in range(d.unpack("i")):
            folder = d.string()
            for _ in range(d.unpack("i")):
                name = d.string()
                offset = d.unpack("i")
                files[mount + folder.lstrip("/") + name] = offset
        self.encoded = encoded
        return files

    def read(self, path):
        at = self.files[path]
        if at < 0:
            raise ValueError(f"{path} has an unsupported index entry")
        e = Reader(self.encoded, at)
        bits = e.unpack("I")
        method = (bits >> 23) & 0x3F
        encrypted = (bits >> 22) & 1
        if method or encrypted:
            raise ValueError(f"{path} is compressed or encrypted")
        offset = e.unpack("I" if bits & (1 << 31) else "Q")
        size = e.unpack("I" if bits & (1 << 30) else "Q")
        self.file.seek(offset + ENTRY_HEADER_SIZE)
        return self.file.read(size)


def read_locres(data):
    """Returns {(namespace, key): text} from a .locres file."""
    if data[:16] != LOCRES_MAGIC:
        raise ValueError("not a compact .locres file")
    r = Reader(data, 16)
    version = r.unpack("B")
    if version < 2:
        raise ValueError(f"unsupported .locres version {version}")
    strings_at = r.unpack("q")
    if version >= 3:
        r.skip(4)  # total entry count

    s = Reader(data, strings_at)
    strings = []
    for _ in range(s.unpack("i")):
        strings.append(s.string())
        s.skip(4)  # reference count

    out = {}
    for _ in range(r.unpack("I")):
        r.skip(4)  # namespace hash
        namespace = r.string()
        for _ in range(r.unpack("I")):
            r.skip(4)  # key hash
            key = r.string()
            r.skip(4)  # source string hash
            out[(namespace, key)] = strings[r.unpack("i")]
    return out
