import net from 'node:net';

export type ClamResult =
  | { result: 'clean'; version: string }
  | { result: 'infected'; signature: string; version: string }
  | { result: 'error'; message: string };
export interface FileScanner {
  scan(data: Buffer): Promise<ClamResult>;
}

/** Sends one command to clamd (null-terminated style) and collects the reply. */
function talk(
  host: string,
  port: number,
  timeoutMs: number,
  write: (s: net.Socket) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const chunks: Buffer[] = [];
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('clamd timeout')));
    socket.on('connect', () => write(socket));
    socket.on('data', (d) => chunks.push(d));
    socket.on('error', reject);
    socket.on('close', () =>
      resolve(Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim()),
    );
  });
}

// Vendor claim to verify with a real clamd: INSTREAM framing (4-byte big-endian length per chunk, zero-length end)
// and replies "stream: OK" / "stream: <name> FOUND" / "... ERROR". clamd refuses streams above its StreamMaxLength.
export function createClamdScanner(opts: {
  host: string;
  port: number;
  timeoutMs?: number;
}): FileScanner {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return {
    async scan(data) {
      try {
        const version = await talk(opts.host, opts.port, timeoutMs, (s) => s.end('zVERSION\0'));
        const reply = await talk(opts.host, opts.port, timeoutMs, (s) => {
          s.write('zINSTREAM\0');
          for (let i = 0; i < data.length; i += 65_536) {
            const chunk = data.subarray(i, i + 65_536);
            const header = Buffer.alloc(4);
            header.writeUInt32BE(chunk.length);
            s.write(header);
            s.write(chunk);
          }
          s.end(Buffer.alloc(4));
        });
        if (reply.endsWith('OK')) return { result: 'clean', version };
        const found = /^stream:\s*(.+)\s+FOUND$/.exec(reply);
        if (found) return { result: 'infected', signature: found[1]!, version };
        return { result: 'error', message: 'unexpected clamd reply' };
      } catch (error) {
        return {
          result: 'error',
          message: error instanceof Error ? error.message : 'clamd failure',
        };
      }
    },
  };
}
