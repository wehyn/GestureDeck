import { createServer } from 'node:http';
import { attachRedisCloudRemote } from '../src/cloud-remote-redis-server.js';

// Keep WebSocket traffic on its own direct Vercel Function route. Rewriting
// WebSocket upgrades to the HTTP API route causes Vercel to close the upgraded
// socket with a 404 after the handshake.
const server = createServer();
attachRedisCloudRemote(server);

export default server;
