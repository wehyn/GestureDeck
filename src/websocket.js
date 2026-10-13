import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { TextDecoder } from 'node:util';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const CLOSE_CODE_NORMAL = 1000;
const CLOSE_CODE_PROTOCOL_ERROR = 1002;
const CLOSE_CODE_UNSUPPORTED_DATA = 1003;
const CLOSE_CODE_INVALID_DATA = 1007;
const CLOSE_CODE_TOO_LARGE = 1009;
const CLOSE_CODE_SERVER_ERROR = 1011;

function isValidCloseCode(code) {
  return Number.isInteger(code)
    && ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code))
      || (code >= 3000 && code <= 4999));
}

function makeFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (data.length <= 125) {
    header = Buffer.alloc(2);
    header[1] = data.length;
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

function sendHttpError(socket, status, message) {
  const body = Buffer.from(`${message}\n`);
  const header = Buffer.from([
    `HTTP/1.1 ${status} ${message}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${body.length}`,
    '',
    '',
  ].join('\r\n'));
  socket.end(Buffer.concat([header, body]));
}

function hasToken(header, expectedToken) {
  return typeof header === 'string'
    && header.split(',').some((token) => token.trim().toLowerCase() === expectedToken);
}

function isValidWebSocketKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) return false;
  const decoded = Buffer.from(key, 'base64');
  return decoded.length === 16 && decoded.toString('base64') === key;
}

/**
 * Attach a small RFC 6455 JSON server to an existing Node HTTP server.
 *
 * `verifyRequest(request)` must synchronously return true before the HTTP upgrade is accepted.
 * `closeTimeoutMs` bounds how long a server-initiated close waits for its peer.
 * `onConnection(connection, request)` receives an EventEmitter with:
 * - `connection.on('message', (value) => ...)` for parsed JSON text messages
 * - `connection.on('close', (code, reason) => ...)` when the socket closes
 * - `connection.send(value)` to JSON-serialize and send a server text frame
 * - `connection.close(code = 1000, reason = '')` to start a close handshake
 *
 * The returned function detaches the upgrade handler and closes active peers.
 */
export function attachWebSocketServer(server, {
  path,
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
  closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
  verifyRequest,
  onConnection,
} = {}) {
  if (!server || typeof server.on !== 'function' || typeof server.off !== 'function') {
    throw new TypeError('server must be a Node HTTP server');
  }
  if (typeof path !== 'string' || !path.startsWith('/') || /[?#\s]/.test(path)) {
    throw new TypeError('path must be an absolute URL path');
  }
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 0) {
    throw new TypeError('maxPayloadBytes must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs < 0 || closeTimeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError('closeTimeoutMs must be an integer between 0 and 2147483647');
  }
  if (typeof verifyRequest !== 'function') {
    throw new TypeError('verifyRequest must be a function');
  }
  if (typeof onConnection !== 'function') {
    throw new TypeError('onConnection must be a function');
  }

  const activeConnections = new Set();

  const onUpgrade = (request, socket, head) => {
    const requestTarget = request.url ?? '';
    const routeMatches = requestTarget === path || requestTarget.startsWith(`${path}?`);
    if (!routeMatches) {
      sendHttpError(socket, 404, 'Not Found');
      return;
    }

    let authorized = false;
    try {
      authorized = verifyRequest(request) === true;
    } catch {
      authorized = false;
    }
    if (!authorized) {
      sendHttpError(socket, 403, 'Forbidden');
      return;
    }

    const key = request.headers['sec-websocket-key'];
    const validHandshake = request.method === 'GET'
      && hasToken(request.headers.upgrade, 'websocket')
      && hasToken(request.headers.connection, 'upgrade')
      && request.headers['sec-websocket-version'] === '13'
      && isValidWebSocketKey(key);
    if (!validHandshake) {
      sendHttpError(socket, 400, 'Bad Request');
      return;
    }

    const accept = createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'));

    const { connection, receive } = createConnection(socket, maxPayloadBytes, closeTimeoutMs);
    activeConnections.add(connection);
    connection.once('close', () => activeConnections.delete(connection));
    try {
      onConnection(connection, request);
    } catch {
      connection.close(CLOSE_CODE_SERVER_ERROR, 'Connection setup failed');
    }
    if (head.length > 0) receive(head);
  };

  server.on('upgrade', onUpgrade);
  return () => {
    server.off('upgrade', onUpgrade);
    for (const connection of activeConnections) {
      connection.close(1001, 'Server shutting down');
    }
  };
}

function createConnection(socket, maxPayloadBytes, closeTimeoutMs) {
  const connection = new EventEmitter();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let input = Buffer.alloc(0);
  let closing = false;
  let closeEventSent = false;
  let closeCode;
  let closeReason = '';
  let closeTimer;
  let fragmentedPayloads = null;
  let fragmentedBytes = 0;

  const clearCloseTimer = () => {
    if (closeTimer !== undefined) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
  };

  const endWithClose = (code, reason = '') => {
    if (closing || socket.destroyed) return;
    closing = true;
    fragmentedPayloads = null;
    fragmentedBytes = 0;
    closeCode = code;
    closeReason = reason;
    const reasonBytes = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    socket.write(makeFrame(0x8, payload));
    closeTimer = setTimeout(() => {
      closeTimer = undefined;
      if (!socket.destroyed) socket.destroy();
    }, closeTimeoutMs);
  };

  const protocolError = (code = CLOSE_CODE_PROTOCOL_ERROR, reason = '') => {
    input = Buffer.alloc(0);
    fragmentedPayloads = null;
    fragmentedBytes = 0;
    if (closing) {
      socket.destroy();
      return;
    }
    endWithClose(code, reason);
  };

  const deliverJson = (payload) => {
    let message;
    try {
      message = JSON.parse(decoder.decode(payload));
    } catch {
      protocolError(CLOSE_CODE_INVALID_DATA, 'Expected JSON text');
      return false;
    }
    try {
      connection.emit('message', message);
    } catch {
      protocolError(CLOSE_CODE_SERVER_ERROR, 'Message handler failed');
      return false;
    }
    return true;
  };

  connection.send = (value) => {
    if (closing || socket.destroyed) return false;
    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch (error) {
      throw new TypeError(`WebSocket message must be JSON-serializable: ${error.message}`);
    }
    if (serialized === undefined) throw new TypeError('WebSocket message must serialize to JSON');
    if (Buffer.byteLength(serialized, 'utf8') > maxPayloadBytes) {
      throw new RangeError('WebSocket message exceeds maxPayloadBytes');
    }
    const payload = Buffer.from(serialized, 'utf8');
    return socket.write(makeFrame(0x1, payload));
  };

  connection.close = (code = CLOSE_CODE_NORMAL, reason = '') => {
    if (!isValidCloseCode(code)) throw new RangeError('Invalid WebSocket close code');
    if (typeof reason !== 'string') throw new TypeError('WebSocket close reason must be a string');
    const reasonBytes = Buffer.from(reason, 'utf8');
    if (reasonBytes.length > 123) throw new RangeError('WebSocket close reason must be at most 123 UTF-8 bytes');
    if (closing || socket.destroyed) return false;
    endWithClose(code, reason);
    return true;
  };

  const receive = (chunk) => {
    if (socket.destroyed) return;
    input = input.length === 0 ? Buffer.from(chunk) : Buffer.concat([input, chunk]);
    while (true) {
      if (input.length < 2) return;
      const first = input[0];
      const second = input[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      const initialLength = second & 0x7f;

      if ((first & 0x70) !== 0 || !masked) {
        protocolError();
        return;
      }
      if (![0x0, 0x1, 0x2, 0x8, 0x9, 0xA].includes(opcode)) {
        protocolError();
        return;
      }
      if (!closing && opcode === 0x2) {
        protocolError(CLOSE_CODE_UNSUPPORTED_DATA, 'Binary messages are not supported');
        return;
      }
      if (!closing && opcode === 0x0 && fragmentedPayloads === null) {
        protocolError();
        return;
      }
      if (!closing && opcode === 0x1 && fragmentedPayloads !== null) {
        protocolError();
        return;
      }
      if (opcode >= 0x8 && (!fin || initialLength > 125)) {
        protocolError();
        return;
      }

      let payloadLength = initialLength;
      let offset = 2;
      if (initialLength === 126) {
        if (input.length < 4) return;
        payloadLength = input.readUInt16BE(2);
        offset = 4;
        if (payloadLength < 126) {
          protocolError();
          return;
        }
      } else if (initialLength === 127) {
        if (input.length < 10) return;
        const wideLength = input.readBigUInt64BE(2);
        if (wideLength & (1n << 63n) || wideLength < 65536n) {
          protocolError();
          return;
        }
        const dataFrame = opcode === 0x0 || opcode === 0x1 || opcode === 0x2;
        const aggregateLimit = closing
          ? maxPayloadBytes
          : maxPayloadBytes - (opcode === 0x0 ? fragmentedBytes : 0);
        if (dataFrame && wideLength > BigInt(aggregateLimit)) {
          protocolError(CLOSE_CODE_TOO_LARGE, 'Message too large');
          return;
        }
        payloadLength = Number(wideLength);
        offset = 10;
      }
      const dataFrame = opcode === 0x0 || opcode === 0x1 || opcode === 0x2;
      const aggregateLimit = closing
        ? maxPayloadBytes
        : maxPayloadBytes - (opcode === 0x0 ? fragmentedBytes : 0);
      if (dataFrame && payloadLength > aggregateLimit) {
        protocolError(CLOSE_CODE_TOO_LARGE, 'Message too large');
        return;
      }
      const frameLength = offset + 4 + payloadLength;
      if (input.length < frameLength) return;

      const maskOffset = offset;
      const mask = input.subarray(maskOffset, maskOffset + 4);
      const payload = Buffer.from(input.subarray(maskOffset + 4, frameLength));
      input = input.subarray(frameLength);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];

      // Once our close frame has gone out, consume but do not act on other
      // frames while waiting for the peer's close response.
      if (closing && opcode !== 0x8) continue;

      if (opcode === 0x8) {
        if (payload.length === 1) {
          protocolError();
          return;
        }
        let peerCloseCode;
        let reason = '';
        if (payload.length >= 2) {
          peerCloseCode = payload.readUInt16BE(0);
          if (!isValidCloseCode(peerCloseCode)) {
            protocolError();
            return;
          }
          try {
            reason = decoder.decode(payload.subarray(2));
          } catch {
            protocolError(CLOSE_CODE_INVALID_DATA, 'Invalid close reason');
            return;
          }
        }
        closeCode = peerCloseCode ?? 1005;
        closeReason = reason;
        fragmentedPayloads = null;
        fragmentedBytes = 0;
        if (!closing) {
          closing = true;
          socket.end(makeFrame(0x8, payload));
        } else {
          clearCloseTimer();
          socket.end();
        }
        return;
      }
      if (opcode === 0x9) {
        if (!closing) socket.write(makeFrame(0xA, payload));
        continue;
      }
      if (opcode === 0xA) continue;

      if (opcode === 0x1 && !fin) {
        fragmentedPayloads = payload.length > 0 ? [payload] : [];
        fragmentedBytes = payload.length;
        continue;
      }
      if (opcode === 0x0) {
        if (payload.length > 0) fragmentedPayloads.push(payload);
        fragmentedBytes += payload.length;
        if (!fin) continue;
        const completePayload = Buffer.concat(fragmentedPayloads, fragmentedBytes);
        fragmentedPayloads = null;
        fragmentedBytes = 0;
        if (!deliverJson(completePayload)) return;
        continue;
      }
      if (!deliverJson(payload)) return;
    }
  };

  socket.on('data', receive);
  socket.on('close', () => {
    clearCloseTimer();
    if (closeEventSent) return;
    closeEventSent = true;
    connection.emit('close', closeCode, closeReason);
  });
  socket.on('error', () => {
    clearCloseTimer();
    if (closeEventSent) return;
    closeEventSent = true;
    connection.emit('close', closeCode, closeReason);
  });

  return { connection, receive };
}
