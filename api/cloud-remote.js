import { createServer } from 'node:http';
import { attachRedisCloudRemote } from '../src/cloud-remote-redis-server.js';

const server = createServer();
attachRedisCloudRemote(server);

export default server;
