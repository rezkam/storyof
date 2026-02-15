/**
 * StoryOf — WebSocket helpers (RFC 6455).
 */

import * as crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

export interface WsClient {
	socket: Socket;
	send: (data: string) => void;
	onMessage: (handler: (msg: Record<string, unknown>) => void) => void;
	alive: boolean;
}

export function wsAccept(
	req: IncomingMessage,
	socket: Socket,
): WsClient | null {
	const key = req.headers["sec-websocket-key"];
	if (!key) return null;
	const accept = crypto
		.createHash("sha1")
		.update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
		.digest("base64");
	socket.write(
		`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
	);

	const send = (data: string) => {
		try {
			const payload = Buffer.from(data, "utf-8");
			const len = payload.length;
			let header: Buffer;
			if (len < 126) {
				header = Buffer.alloc(2);
				header[0] = 0x81;
				header[1] = len;
			} else if (len < 65536) {
				header = Buffer.alloc(4);
				header[0] = 0x81;
				header[1] = 126;
				header.writeUInt16BE(len, 2);
			} else {
				header = Buffer.alloc(10);
				header[0] = 0x81;
				header[1] = 127;
				header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
				header.writeUInt32BE(len % 0x100000000, 6);
			}
			socket.write(Buffer.concat([header, payload]));
		} catch {}
	};

	const messageHandlers: Array<(msg: Record<string, unknown>) => void> = [];

	const client: WsClient = {
		socket,
		send,
		onMessage: (handler) => messageHandlers.push(handler),
		alive: true,
	};

	let frameBuf = Buffer.alloc(0);

	const processFrames = () => {
		while (frameBuf.length >= 2) {
			const opcode = frameBuf[0] & 0x0f;
			const masked = (frameBuf[1] & 0x80) !== 0;
			let payloadLen = frameBuf[1] & 0x7f;
			let headerLen = 2;
			if (payloadLen === 126) {
				if (frameBuf.length < 4) return;
				payloadLen = frameBuf.readUInt16BE(2);
				headerLen = 4;
			} else if (payloadLen === 127) {
				if (frameBuf.length < 10) return;
				payloadLen = frameBuf.readUInt32BE(6);
				headerLen = 10;
			}
			const maskLen = masked ? 4 : 0;
			const totalLen = headerLen + maskLen + payloadLen;
			if (frameBuf.length < totalLen) return;
			if (opcode === 0x8) {
				socket.end();
				return;
			}
			if (opcode === 0x9) {
				try {
					socket.write(Buffer.from([0x8a, 0]));
				} catch {}
				frameBuf = frameBuf.subarray(totalLen);
				continue;
			}
			if (opcode === 0x1 && masked) {
				const mask = frameBuf.subarray(headerLen, headerLen + 4);
				const data = Buffer.from(frameBuf.subarray(headerLen + 4, headerLen + 4 + payloadLen));
				for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
				try {
					const msg = JSON.parse(data.toString("utf-8"));
					for (const handler of messageHandlers) handler(msg);
				} catch {}
			}
			frameBuf = frameBuf.subarray(totalLen);
		}
	};

	socket.on("data", (chunk: Buffer) => {
		frameBuf = Buffer.concat([frameBuf, chunk]);
		processFrames();
	});
	socket.on("close", () => {
		client.alive = false;
	});
	socket.on("error", () => {
		client.alive = false;
	});

	return client;
}

/** Broadcast a JSON message to all alive clients */
export function wsBroadcast(clients: Set<WsClient>, obj: Record<string, unknown>) {
	const json = JSON.stringify(obj);
	for (const c of clients) if (c.alive) c.send(json);
}
