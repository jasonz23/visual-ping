/** Runtime configuration, sourced from the environment (see .env.example). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface AppConfig {
  baseUrl: string;
  host: string;
  username: string;
  password: string;
  concurrency: number;
  artifactDir: string;
  outDir: string;
  maxPages: number;
  navTimeoutMs: number;
  idleTimeoutMs: number;
  logLevel: LogLevel;
  headless: boolean;
  /**
   * Optional upstream proxy. The target geo-gates one page on the *real* source
   * IP — no forwarded-IP or country header changes it — so the only way to be
   * seen as another region is to originate the request from there. Point this at
   * an exit node in the required country and the whole crawl (documents and
   * subresources alike) routes through it.
   */
  proxy?: ProxyConfig;
}

export interface ProxyConfig {
  /** `scheme://host:port`, e.g. `http://de.example.net:8080` or `socks5://…`. */
  server: string;
  username?: string;
  password?: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Minimal .env loader: no dependency, no interpolation, `#` comments only. */
export function loadDotEnv(file = '.env'): void {
  let raw: string;
  try {
    raw = readFileSync(resolve(process.cwd(), file), 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Environment variable ${name} must be a number`);
  return parsed;
}

function logLevel(): LogLevel {
  const raw = (process.env.VP_LOG_LEVEL ?? 'info') as LogLevel;
  return LOG_LEVELS.includes(raw) ? raw : 'info';
}

export function loadConfig(): AppConfig {
  loadDotEnv();
  const baseUrl = process.env.VP_BASE_URL ?? 'http://54.214.7.161/';
  return {
    baseUrl,
    host: new URL(baseUrl).host,
    username: required('VP_USERNAME'),
    password: required('VP_PASSWORD'),
    concurrency: Math.max(1, num('VP_CONCURRENCY', 3)),
    artifactDir: resolve(process.cwd(), process.env.VP_ARTIFACT_DIR ?? './artifacts'),
    outDir: resolve(process.cwd(), process.env.VP_OUT_DIR ?? './out'),
    maxPages: num('VP_MAX_PAGES', 2000),
    navTimeoutMs: num('VP_NAV_TIMEOUT_MS', 30_000),
    idleTimeoutMs: num('VP_IDLE_TIMEOUT_MS', 8_000),
    logLevel: logLevel(),
    headless: process.env.VP_HEADLESS !== 'false',
    proxy: parseProxy(process.env.VP_PROXY),
  };
}

/**
 * Parse `VP_PROXY` into Playwright's proxy shape. Accepts an optional
 * `user:pass@` prefix; credentials are lifted out of the URL so they are not
 * duplicated in the `server` field.
 */
export function parseProxy(raw: string | undefined): ProxyConfig | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`VP_PROXY must be a URL like http://host:port (got "${raw}")`);
  }
  const server = `${url.protocol}//${url.host}`;
  const config: ProxyConfig = { server };
  if (url.username) config.username = decodeURIComponent(url.username);
  if (url.password) config.password = decodeURIComponent(url.password);
  return config;
}
