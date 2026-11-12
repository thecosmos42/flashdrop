import fs from 'node:fs';
import path from 'node:path';

export type NodeName = 'buyer' | 'seller' | 'courier';
export type NodeConfig = { url: string; cert: Buffer; macaroon: string };
export type Config = {
  port: number; origin: string; databasePath: string; runtimeDir: string;
  nodes: Record<NodeName, NodeConfig>; releaseKey: Buffer;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing configuration variable: ${name}`);
  return value;
}

function node(name: NodeName): NodeConfig {
  const prefix = name.toUpperCase();
  const url = new URL(required(`${prefix}_LND_URL`));
  if (url.protocol !== 'https:') throw new Error(`${prefix}_LND_URL must use HTTPS`);
  return {
    url: url.origin,
    cert: fs.readFileSync(required(`${prefix}_TLS_CERT`)),
    macaroon: fs.readFileSync(required(`${prefix}_MACAROON`)).toString('hex')
  };
}

export function loadConfig(): Config {
  if (process.env.BITCOIN_NETWORK !== 'regtest') throw new Error('Only regtest is supported');
  const databasePath = path.resolve(required('DATABASE_PATH'));
  const runtimeDir = path.dirname(databasePath);
  fs.mkdirSync(runtimeDir, { recursive: true });
  const releaseKey = fs.readFileSync(required('RELEASE_KEY_FILE'));
  if (releaseKey.length !== 32) throw new Error('Release key must contain exactly 32 bytes');
  return {
    port: Number(process.env.APP_PORT ?? '3000'),
    origin: process.env.APP_ORIGIN ?? 'http://127.0.0.1:3000',
    databasePath, runtimeDir,
    nodes: { buyer: node('buyer'), seller: node('seller'), courier: node('courier') },
    releaseKey
  };
}
