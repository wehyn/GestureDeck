import { createServer } from 'node:http';
import { attachCloudRemote } from '../src/cloud-remote-server.js';

const server = createServer();
attachCloudRemote(server);

export default server;
