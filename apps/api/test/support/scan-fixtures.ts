// Synthetic hostile and harmless files for scanner tests. Nothing here is real malware.
import net from 'node:net';
import { deflateSync } from 'node:zlib';
import type { ObjectStore } from '../../src/services/object-store';

const CRC_TABLE = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();
export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The standard anti-virus test string, assembled at run time so this file itself does not trip desktop scanners. */
export const eicar = () =>
  ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE', '!$H+H*'].join('');

// ---- PNG ----
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])));
  return Buffer.concat([head, data, crc]);
}
export function makePng(
  o: { width?: number; height?: number; metadata?: boolean; trailing?: Buffer } = {},
): Buffer {
  const width = o.width ?? 2;
  const height = o.height ?? 2;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const small = width * height <= 100;
  const raw = small ? Buffer.alloc(height * (1 + width * 3), 0x7f) : Buffer.from([0, 1, 2, 3]);
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
  ];
  if (o.metadata) {
    parts.push(pngChunk('tEXt', Buffer.from('Author\0Synthetic Person', 'latin1')));
    parts.push(pngChunk('eXIf', Buffer.from('synthetic-gps-data')));
  }
  parts.push(pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)));
  if (o.trailing) parts.push(o.trailing);
  return Buffer.concat(parts);
}

// ---- JPEG (structure only; not decodable pixels) ----
function jseg(marker: number, payload: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}
export function makeJpeg(o: { width?: number; height?: number; metadata?: boolean } = {}): Buffer {
  const sof = Buffer.alloc(15);
  sof[0] = 8;
  sof.writeUInt16BE(o.height ?? 4, 1);
  sof.writeUInt16BE(o.width ?? 4, 3);
  sof[5] = 3;
  const parts = [
    Buffer.from([0xff, 0xd8]),
    jseg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
  ];
  if (o.metadata) {
    parts.push(
      jseg(0xe1, Buffer.from('Exif\0\0synthetic-gps-data')),
      jseg(0xfe, Buffer.from('synthetic comment')),
    );
  }
  parts.push(
    jseg(0xdb, Buffer.alloc(65, 1)),
    jseg(0xc0, sof),
    jseg(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]),
    Buffer.from([0xff, 0xd9]),
  );
  return Buffer.concat(parts);
}

// ---- PDF (text structure) ----
export function makePdf(
  o: { pages?: number; js?: boolean; encrypted?: boolean; payload?: string } = {},
): Buffer {
  const pages = o.pages ?? 1;
  let body =
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count ' +
    pages +
    ' >>\nendobj\n';
  for (let i = 0; i < pages; i++)
    body += `${3 + i} 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n`;
  if (o.js) body += '9 0 obj\n<< /S /JavaScript /JS (app.alert(1)) >>\nendobj\n';
  if (o.encrypted) body += 'trailer\n<< /Encrypt 10 0 R >>\n';
  if (o.payload) body += `% ${o.payload}\n`;
  return Buffer.from(body + '%%EOF\n', 'latin1');
}

// ---- ZIP / DOCX (stored entries; the directory can lie about sizes to model a bomb) ----
export function makeZip(
  entries: Array<{ name: string; data?: Buffer; declaredSize?: number; flags?: number }>,
): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data ?? Buffer.from('x');
    const name = Buffer.from(e.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 0, 6);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(e.flags ?? 0, 8);
    cd.writeUInt32LE(crc32(data), 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(e.declaredSize ?? data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}
export const makeDocx = (extra: Parameters<typeof makeZip>[0] = []) =>
  makeZip([{ name: '[Content_Types].xml' }, { name: 'word/document.xml' }, ...extra]);

// ---- in-memory object store ----
export function createMemoryStore() {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const k = (b: string, key: string) => `${b}/${key}`;
  const store: ObjectStore & { objects: typeof objects; has: (b: string, key: string) => boolean } =
    {
      objects,
      has: (b, key) => objects.has(k(b, key)),
      async head(b, key) {
        const o = objects.get(k(b, key));
        return o ? { size: o.body.length } : null;
      },
      async get(b, key, max) {
        const o = objects.get(k(b, key));
        if (!o) throw new Error('not found');
        if (o.body.length > max) throw new Error('too large');
        return Buffer.from(o.body);
      },
      async put(b, key, body, contentType) {
        objects.set(k(b, key), { body: Buffer.from(body), contentType });
      },
      async delete(b, key) {
        objects.delete(k(b, key));
      },
      async presignUpload(input) {
        return {
          url: 'https://fake.invalid/' + input.key,
          method: 'PUT',
          headers: {},
          expiresAt: new Date(),
        };
      },
    };
  return store;
}

// ---- fake clamd speaking the INSTREAM protocol; flags the EICAR string as infected ----
export async function startFakeClamd() {
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const nul = buf.indexOf(0);
      if (nul < 0) return;
      const command = buf.subarray(0, nul).toString();
      if (command === 'zVERSION') return void socket.end('ClamAV 1.4.0-test/27000/Sun\0');
      if (command !== 'zINSTREAM') return void socket.end('UNKNOWN COMMAND\0');
      let p = nul + 1;
      const data: Buffer[] = [];
      while (p + 4 <= buf.length) {
        const len = buf.readUInt32BE(p);
        if (len === 0) {
          const infected = Buffer.concat(data).includes(eicar());
          return void socket.end(
            infected ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0',
          );
        }
        if (p + 4 + len > buf.length) return;
        data.push(buf.subarray(p + 4, p + 4 + len));
        p += 4 + len;
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}
