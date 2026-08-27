#!/usr/bin/env python3
"""
wwpak.py - reader for Whiskerwood (UE 5.6) .pak archives.

Whiskerwood ships a single unencrypted, uncompressed PakFile v11 archive, so the
index can be walked and files pulled out without UnrealPak or an AES key.

    python wwpak.py list   <file.pak> [regex]
    python wwpak.py info   <file.pak>
    python wwpak.py unpack <file.pak> <outdir> [regex]

Compressed entries (mod paks built by UnrealPak default to Oodle) are reported
but not decoded - use UnrealPak/repak/FModel for those.
"""
import os
import re
import struct
import sys

FOOTER_SIZE = 221          # v11: guid16 + enc1 + magic4 + ver4 + off8 + size8 + sha20 + 5*32
PAK_MAGIC = 0x5A6F12E1
ENTRY_HEADER_SIZE = 53     # serialized FPakEntry preceding each file's payload


class Reader:
    def __init__(self, buf, pos=0):
        self.buf, self.pos = buf, pos

    def _take(self, fmt, n):
        v = struct.unpack_from(fmt, self.buf, self.pos)[0]
        self.pos += n
        return v

    def u32(self):  return self._take('<I', 4)
    def i32(self):  return self._take('<i', 4)
    def i64(self):  return self._take('<q', 8)
    def u64(self):  return self._take('<Q', 8)

    def raw(self, n):
        v = self.buf[self.pos:self.pos + n]
        self.pos += n
        return v

    def fstring(self):
        n = self.i32()
        if n == 0:
            return ''
        if n < 0:                                   # negative length => UTF-16
            s = self.buf[self.pos:self.pos - 2 * n].decode('utf-16-le')
            self.pos += -2 * n
        else:
            s = self.buf[self.pos:self.pos + n].decode('utf-8', 'replace')
            self.pos += n
        return s.rstrip('\x00')


def decode_entry(blob, offset):
    """Decode one bit-packed FPakEntry from the encoded-entries block."""
    r = Reader(blob, offset)
    v = r.u32()
    method = (v >> 23) & 0x3F
    entry = {
        'method': method,
        'encrypted': bool(v & (1 << 22)),
        'offset': r.u32() if v & (1 << 31) else r.u64(),
    }
    entry['usize'] = r.u32() if v & (1 << 30) else r.u64()
    if method != 0:
        entry['size'] = r.u32() if v & (1 << 29) else r.u64()
    else:
        entry['size'] = entry['usize']
    blocks = (v >> 6) & 0xFFFF
    entry['blocks'] = blocks
    entry['block_size'] = 0
    if blocks:
        entry['block_size'] = (v & 0x3F) << 11
        if (v & 0x3F) == 0x3F:
            entry['block_size'] = r.u32()
    return entry


class Pak:
    def __init__(self, path):
        self.path = path
        self.fh = open(path, 'rb')
        size = os.path.getsize(path)
        self.fh.seek(size - FOOTER_SIZE)
        footer = self.fh.read(FOOTER_SIZE)

        self.key_guid = footer[0:16]
        self.encrypted_index = bool(footer[16])
        magic, self.version = struct.unpack_from('<II', footer, 17)
        if magic != PAK_MAGIC:
            raise SystemExit(f'{path}: not a UE pak (bad magic {magic:#x})')
        index_offset, index_size = struct.unpack_from('<QQ', footer, 25)
        self.methods = [footer[61 + i:61 + i + 32].split(b'\x00')[0].decode('ascii', 'replace')
                        for i in range(0, 160, 32)]

        if self.encrypted_index:
            raise SystemExit(f'{path}: index is AES-encrypted; an AES key is required')

        self.fh.seek(index_offset)
        r = Reader(self.fh.read(index_size))
        self.mount_point = r.fstring()
        self.count = r.i32()
        r.u64()                                     # path hash seed
        if r.i32():                                 # path hash index
            r.i64(); r.i64(); r.raw(20)
        full_dir_offset = full_dir_size = 0
        if r.i32():                                 # full directory index
            full_dir_offset, full_dir_size = r.i64(), r.i64()
            r.raw(20)
        self.encoded = r.raw(r.i32())

        if not full_dir_offset:
            raise SystemExit(f'{path}: no full directory index; filenames unavailable')
        self.fh.seek(full_dir_offset)
        r = Reader(self.fh.read(full_dir_size))
        self.files = {}
        for _ in range(r.i32()):
            directory = r.fstring()
            for _ in range(r.i32()):
                name = r.fstring()
                self.files[directory + name] = r.u32()

    def entry(self, path):
        return decode_entry(self.encoded, self.files[path])

    def read(self, path):
        e = self.entry(path)
        if e['encrypted']:
            raise ValueError(f'{path}: entry is encrypted')
        if e['method'] != 0:
            raise ValueError(f"{path}: {self.methods[e['method'] - 1] or 'unknown'}-compressed; "
                             f'not supported by this tool')
        self.fh.seek(e['offset'] + ENTRY_HEADER_SIZE)
        return self.fh.read(e['size'])


def _selected(pak, pattern):
    if not pattern:
        return sorted(pak.files)
    rx = re.compile(pattern, re.I)
    return sorted(p for p in pak.files if rx.search(p))


def main(argv):
    if len(argv) < 3:
        print(__doc__.strip())
        return 1
    cmd, pak_path = argv[1], argv[2]
    pak = Pak(pak_path)

    if cmd == 'info':
        print(f'path         : {pak.path}')
        print(f'pak version  : {pak.version}')
        print(f'mount point  : {pak.mount_point}')
        print(f'entries      : {pak.count}')
        print(f'encrypted    : {pak.encrypted_index or pak.key_guid != b"\x00" * 16}')
        print(f'compression  : {[m for m in pak.methods if m] or ["none"]}')
        total = sum(pak.entry(p)['usize'] for p in pak.files)
        print(f'uncompressed : {total / 1e9:.2f} GB')
        return 0

    if cmd == 'list':
        for p in _selected(pak, argv[3] if len(argv) > 3 else None):
            e = pak.entry(p)
            tag = pak.methods[e['method'] - 1] if e['method'] else ''
            print(f"{e['usize']:>12}  {tag:<7} {p}")
        return 0

    if cmd == 'unpack':
        if len(argv) < 4:
            print('unpack needs an output directory')
            return 1
        outdir = argv[3]
        done = skipped = 0
        for p in _selected(pak, argv[4] if len(argv) > 4 else None):
            try:
                data = pak.read(p)
            except ValueError as exc:
                print(f'skip: {exc}', file=sys.stderr)
                skipped += 1
                continue
            dst = os.path.join(outdir, p.replace('/', os.sep))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, 'wb') as fh:
                fh.write(data)
            done += 1
        print(f'extracted {done} file(s) to {outdir}' + (f'; {skipped} skipped' if skipped else ''))
        return 0

    print(f'unknown command: {cmd}')
    return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
