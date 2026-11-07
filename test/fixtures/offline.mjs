import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

const forbidden = () => { throw new Error('NETWORK_DISABLED_BY_PROJECT_FIXTURE'); };
globalThis.fetch = forbidden;
net.connect = net.createConnection = tls.connect = http.request = https.request = forbidden;
syncBuiltinESMExports();
