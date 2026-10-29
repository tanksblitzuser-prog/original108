'use strict';
/*
 * wslite — tashqi kutubxonasiz minimal WebSocket server (RFC 6455).
 * Faqat matnli xabarlar, ping/pong, close va bo'lingan (fragmented) kadrlar qo'llab-quvvatlanadi.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Conn extends EventEmitter {
  constructor(socket, maxPayload) {
    super();
    this.socket = socket;
    this.max = maxPayload;
    this.buf = Buffer.alloc(0);
    this.open = true;
    this.alive = true;
    this.frag = null;
    this.fragLen = 0;
    socket.setNoDelay(true);
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => { /* close hodisasi kelib chiqadi */ });
  }

  _closed() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }

  _frame(opcode, payload) {
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
    else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    head[0] = 0x80 | opcode;
    return Buffer.concat([head, payload]);
  }

  send(text) {
    if (!this.open) return;
    if (this.socket.writableLength > 1024 * 1024) { this.terminate(); return; }
    this.socket.write(this._frame(0x1, Buffer.from(String(text), 'utf8')));
  }

  ping() { if (this.open) this.socket.write(this._frame(0x9, Buffer.alloc(0))); }

  close(code = 1000) {
    if (!this.open) return;
    try {
      const p = Buffer.alloc(2); p.writeUInt16BE(code, 0);
      this.socket.write(this._frame(0x8, p));
      this.socket.end();
    } catch (e) { /* ignore */ }
    const t = setTimeout(() => this.terminate(), 1500); t.unref();
  }

  terminate() {
    try { this.socket.destroy(); } catch (e) { /* ignore */ }
    this._closed();
  }

  _onData(d) {
    this.alive = true;
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (this.buf.length > this.max * 2 + 64) { this.close(1009); this.buf = Buffer.alloc(0); return; }
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = !!(b[0] & 0x80), opcode = b[0] & 0x0f, masked = !!(b[1] & 0x80);
      let len = b[1] & 0x7f, off = 2;
      if (b[0] & 0x70) { this.close(1002); this.buf = Buffer.alloc(0); return; }
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        if (b.readUInt32BE(2) !== 0) { this.close(1009); this.buf = Buffer.alloc(0); return; }
        len = b.readUInt32BE(6); off = 10;
      }
      if (!masked) { this.close(1002); this.buf = Buffer.alloc(0); return; }
      if (len > this.max) { this.close(1009); this.buf = Buffer.alloc(0); return; }
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);

      if (opcode >= 0x8) {                      // boshqaruv kadrlari
        if (!fin || len > 125) { this.close(1002); return; }
        if (opcode === 0x8) { this.close(1000); return; }
        if (opcode === 0x9) { if (this.open) this.socket.write(this._frame(0xA, payload)); }
        continue;                                // 0xA pong — alive allaqachon true
      }
      if (opcode === 0x2) { this.close(1003); return; }       // binar qo'llab-quvvatlanmaydi
      if (opcode === 0x1) { this.frag = [payload]; this.fragLen = len; }
      else if (opcode === 0x0) {
        if (!this.frag) { this.close(1002); return; }
        this.fragLen += len;
        if (this.fragLen > this.max) { this.close(1009); return; }
        this.frag.push(payload);
      } else { this.close(1002); return; }
      if (fin) {
        const msg = Buffer.concat(this.frag).toString('utf8');
        this.frag = null; this.fragLen = 0;
        this.emit('message', msg);
      }
    }
  }
}

function attach(server, wsPath, onConnection, opts = {}) {
  const max = opts.maxPayload || 4096;
  const conns = new Set();
  server.on('upgrade', (req, socket) => {
    const url = (req.url || '').split('?')[0];
    const key = req.headers['sec-websocket-key'];
    const up = String(req.headers.upgrade || '').toLowerCase();
    if (url !== wsPath || !key || up !== 'websocket' || req.headers['sec-websocket-version'] !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    if (opts.verifyOrigin && !opts.verifyOrigin(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const c = new Conn(socket, max);
    conns.add(c);
    c.on('close', () => conns.delete(c));
    onConnection(c, req);
  });
  // yuragi urishi: javob bermagan ulanishlarni yopish (Render kabi proksilar uchun ham foydali)
  const iv = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) { c.terminate(); continue; }
      c.alive = false; c.ping();
    }
  }, opts.pingMs || 25000);
  iv.unref();
  return { conns };
}

module.exports = { attach };
