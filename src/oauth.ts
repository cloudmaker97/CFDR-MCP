import express, { type Response } from 'express';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError, InvalidRequestError, TooManyRequestsError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { LEGAL_DISCLAIMER } from './disclaimer.js';
import type { Config } from './config.js';

const SCOPE = 'legal:read';
const ACCESS_SECONDS = 3600;
const GRANT_SECONDS = 30 * 86400;
const now = () => Math.floor(Date.now() / 1000);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const cookieName = (id: string) => `legal_oauth_csrf_${hash(id).slice(0, 16)}`;
const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
type Grant = { client: string; expires: number; revoked: boolean };
type Credential = { grant: string; client: string; expires: number; used?: boolean };
type Pending = { client: string; params: AuthorizationParams; csrf: string; attempts: number };
type Code = { client: string; challenge: string; redirect: string; grant: string; used?: boolean; expires: number };

/** Single-process, indexed SQLite credential store. Bearer credentials are stored only as hashes. */
export class ApiKeyOAuthProvider implements OAuthServerProvider {
  // Validate verifier syntax and S256 together when consuming the code, atomically with issuance.
  readonly skipLocalPkceValidation = true;
  readonly issuer: URL;
  readonly resource: URL;
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly db: DatabaseSync;
  private readonly selectRecord: StatementSync;
  private readonly writeRecord: StatementSync;
  private readonly cleanup: ReturnType<typeof setInterval>;

  constructor(private readonly config: Config) {
    this.issuer = new URL(config.publicUrl);
    this.resource = new URL('/mcp', this.issuer);
    mkdirSync(config.dataDir, { recursive: true });
    const file = join(config.dataDir, 'oauth.sqlite');
    if (!existsSync(file)) closeSync(openSync(file, 'wx', 0o600));
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('OAuth database must be a regular file');
    if (process.platform !== 'win32') chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS credentials (kind TEXT NOT NULL, key TEXT NOT NULL, expires INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,key)); CREATE INDEX IF NOT EXISTS credential_expiry ON credentials(expires);');
    this.selectRecord = this.db.prepare('SELECT body FROM credentials WHERE kind=? AND key=? AND expires>?');
    this.writeRecord = this.db.prepare('INSERT OR REPLACE INTO credentials VALUES (?,?,?,?)');
    const version = hash(`${config.token}\n${this.issuer.origin}`);
    if (this.get<string>('meta', 'version') !== version) {
      this.db.exec("DELETE FROM credentials WHERE kind != 'client'");
      this.put('meta', 'version', version, Number.MAX_SAFE_INTEGER);
    }
    this.clientsStore = {
      getClient: id => this.get<OAuthClientInformationFull>('client', id),
      registerClient: metadata => {
        const redirects = metadata.redirect_uris;
        if (!redirects.length || redirects.length > 10 || redirects.some(uri => !this.safeRedirect(uri))) throw new InvalidClientMetadataError('Redirects must use HTTPS or loopback HTTP, without credentials or fragments');
        if (metadata.client_name && metadata.client_name.length > 100) throw new InvalidClientMetadataError('Client name is too long');
        if (!['none', 'client_secret_post'].includes(metadata.token_endpoint_auth_method ?? 'client_secret_post') || metadata.grant_types?.some(type => !['authorization_code', 'refresh_token'].includes(type)) || metadata.response_types?.some(type => type !== 'code')) throw new InvalidClientMetadataError('Unsupported OAuth client settings');
        this.prune();
        const count = this.db.prepare("SELECT count(*) AS n FROM credentials WHERE kind='client'").get()!.n as number;
        if (count >= 1000) throw new TooManyRequestsError('Client registration capacity reached');
        const client: OAuthClientInformationFull = { ...metadata, client_id: randomUUID(), client_id_issued_at: now(), grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
        this.put('client', client.client_id, client, client.client_secret_expires_at || now() + 90 * 86400);
        return client;
      },
    };
    this.cleanup = setInterval(() => this.prune(), 60000);
    this.cleanup.unref();
  }

  private safeRedirect(uri: string) {
    try {
      const u = new URL(uri);
      return uri.length <= 2048 && !u.username && !u.password && !u.hash && (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)));
    } catch { return false; }
  }
  private get<T>(kind: string, key: string): T | undefined {
    if (key.length > 2048) return undefined;
    const row = this.selectRecord.get(kind, key, now());
    return row ? JSON.parse(row.body as string) as T : undefined;
  }
  private put(kind: string, key: string, value: unknown, expires: number) {
    this.writeRecord.run(kind, key, expires, JSON.stringify(value));
  }
  private remove(kind: string, key: string) { this.db.prepare('DELETE FROM credentials WHERE kind=? AND key=?').run(kind, key); }
  private prune() { this.db.prepare('DELETE FROM credentials WHERE expires<=?').run(now()); }
  private audience(resource?: URL) {
    if (resource && resource.href !== this.resource.href) throw new InvalidTargetError('Unknown resource');
  }
  private scopes(scopes?: string[]) {
    if (scopes && (scopes.length !== 1 || scopes[0] !== SCOPE)) throw new InvalidScopeError(`Only ${SCOPE} is supported`);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { clearInterval(this.cleanup); this.db.close(); }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    this.audience(params.resource); this.scopes(params.scopes);
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) || (params.state?.length ?? 0) > 2048) throw new InvalidRequestError('Invalid PKCE challenge or state');
    this.prune();
    const count = this.db.prepare("SELECT count(*) AS n FROM credentials WHERE kind='pending'").get()!.n as number;
    if (count >= 1000) throw new TooManyRequestsError('Too many pending authorizations');
    const id = secret(), csrf = secret();
    this.put('pending', hash(id), { client: client.client_id, params, csrf: hash(csrf), attempts: 0 }, now() + 600);
    res.cookie(cookieName(id), csrf, { httpOnly: true, secure: this.issuer.protocol === 'https:', sameSite: 'lax', path: '/oauth/approve', maxAge: 600000 });
    this.page(res, id, csrf, client, params);
  }

  private page(res: Response, id: string, csrf: string, client: OAuthClientInformationFull, params: AuthorizationParams, error = '') {
    // no-referrer turns browser form POST origins into null; same-origin preserves CSRF checks
    // while withholding the authorization URL from external destinations.
    // Chromium applies form-action to the 303 redirect too. Allow only this registered
    // callback origin, otherwise a successful approval leaves the consumed form on screen.
    const callbackOrigin = new URL(params.redirectUri).origin;
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${callbackOrigin}; frame-ancestors 'none'; base-uri 'none'` });
    res.type('html').send(`<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Klotzkette MCP – Zugriff freigeben</title><style>body{font:17px system-ui;max-width:650px;margin:3rem auto;padding:1rem;line-height:1.6}input{width:95%;padding:.6rem}button{padding:.7rem;margin:.8rem .4rem 0 0}aside{background:#eee;padding:1rem}p.error{color:#a00}</style><h1>Klotzkette MCP</h1><h2>Zugriff freigeben</h2><p>Die Anwendung <strong>${escape(client.client_name || 'Unbenannte Anwendung')}</strong> möchte Inhalte lesen und durchsuchen (${SCOPE}). Der Anwendungsname wurde vom Client angegeben und ist nicht verifiziert.</p><p>Rückleitung: <code>${escape(new URL(params.redirectUri).origin)}</code></p><p>Prüfe diese Anwendung und die Adresse dieser Anmeldeseite: <strong>${escape(this.issuer.origin)}</strong>. Gib deinen API-Schlüssel nur hier ein. Er wird nicht an die Anwendung weitergegeben.</p>${error ? `<p class="error">${escape(error)}</p>` : ''}<form method="post" action="/oauth/approve"><input type="hidden" name="request" value="${id}"><input type="hidden" name="csrf" value="${csrf}"><label>API-Schlüssel (MCP_AUTH_TOKEN)<input type="password" name="api_key" autocomplete="off" maxlength="4096" required></label><button name="action" value="allow">Lesezugriff erlauben</button><button name="action" value="deny" formnovalidate>Abbrechen</button></form><p>Zugriffstokens gelten eine Stunde. Die Freigabe kann bis zu 30 Tage erneuert werden. Eine Änderung des API-Schlüssels widerruft bestehende Freigaben.</p><aside>${escape(LEGAL_DISCLAIMER)}</aside></html>`);
  }

  approvalRouter() {
    const router = express.Router();
    const attempts = new Map<string, { count: number; expires: number }>();
    router.post('/oauth/approve', express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 10 }), (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      for (const [ip, bucket] of attempts) if (bucket.expires <= Date.now()) attempts.delete(ip);
      const ip = req.ip ?? 'unknown';
      let bucket = attempts.get(ip);
      if (!bucket) {
        if (attempts.size >= 10000) { res.status(429).send('Zu viele Anfragen'); return; }
        bucket = { count: 0, expires: Date.now() + 60000 }; attempts.set(ip, bucket);
      }
      if (++bucket.count > 10) { res.set('Retry-After', '60').status(429).send('Zu viele Anmeldeversuche'); return; }
      const { request: id, csrf, api_key: key, action } = req.body ?? {};
      const name = typeof id === 'string' ? cookieName(id) : '';
      const cookie = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
      const pending = typeof id === 'string' ? this.get<Pending>('pending', hash(id)) : undefined;
      if (!pending || typeof csrf !== 'string' || !cookie || !equal(csrf, cookie) || !equal(hash(csrf), pending.csrf) || (req.headers.origin && req.headers.origin !== this.issuer.origin)) {
        res.locals.oauthFailure = !pending ? 'request_missing_or_expired' : !cookie ? 'cookie_missing' : typeof csrf !== 'string' || !equal(csrf, cookie) || !equal(hash(csrf), pending.csrf) ? 'csrf_mismatch' : 'origin_mismatch';
        res.status(403).send('Ungültige oder abgelaufene Anmeldung. Bitte erneut verbinden.'); return;
      }
      const redirect = new URL(pending.params.redirectUri);
      if (pending.params.state !== undefined) redirect.searchParams.set('state', pending.params.state);
      if (action === 'deny') {
        this.remove('pending', hash(id)); redirect.searchParams.set('error', 'access_denied');
      } else if (action === 'allow') {
        if (typeof key !== 'string' || !equal(key, this.config.token)) {
          res.locals.oauthFailure = 'invalid_api_key';
          pending.attempts++;
          if (pending.attempts >= 5) { this.remove('pending', hash(id)); res.status(403).send('Zu viele Fehlversuche. Bitte erneut verbinden.'); return; }
          this.put('pending', hash(id), pending, now() + 300);
          const client = this.clientsStore.getClient(pending.client) as OAuthClientInformationFull | undefined;
          if (!client) { res.status(403).send('Anwendung nicht mehr registriert'); return; }
          res.status(403); this.page(res, id, csrf, client, pending.params, 'API-Schlüssel ungültig.'); return;
        }
        const code = secret(), grant = randomUUID();
        this.transaction(() => {
          this.remove('pending', hash(id));
          this.put('grant', grant, { client: pending.client, expires: now() + GRANT_SECONDS, revoked: false }, now() + GRANT_SECONDS);
          this.put('code', hash(code), { client: pending.client, challenge: pending.params.codeChallenge, redirect: pending.params.redirectUri, grant, expires: now() + 120 }, now() + 120);
        });
        redirect.searchParams.set('code', code);
      } else { res.status(400).send('Ungültige Aktion'); return; }
      res.clearCookie(name, { path: '/oauth/approve', secure: this.issuer.protocol === 'https:', sameSite: 'lax', httpOnly: true });
      res.redirect(303, redirect.href);
    });
    return router;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    const record = this.get<Code>('code', hash(code));
    if (!record || record.client !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
    if (record.used) {
      this.revokeGrant(record.grant);
      throw new InvalidGrantError('Authorization code reuse detected; authorization revoked');
    }
    return record.challenge;
  }
  private issue(grantId: string, clientId: string): OAuthTokens {
    const grant = this.get<Grant>('grant', grantId);
    if (!grant || grant.revoked || grant.client !== clientId) throw new InvalidGrantError('Authorization expired or revoked');
    const access = `mcp_at_${secret()}`, refresh = `mcp_rt_${secret()}`;
    const expires = Math.min(now() + ACCESS_SECONDS, grant.expires);
    this.put('access', hash(access), { grant: grantId, client: clientId, expires }, expires);
    this.put('refresh', hash(refresh), { grant: grantId, client: clientId, expires: grant.expires, used: false }, grant.expires);
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: expires - now(), scope: SCOPE };
  }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, verifier?: string, redirect?: string, resource?: URL) {
    this.audience(resource);
    await this.challengeForAuthorizationCode(client, code);
    return this.transaction(() => {
      const record = this.get<Code>('code', hash(code));
      if (!record || record.used || record.client !== client.client_id || redirect !== record.redirect) throw new InvalidGrantError('Invalid code or redirect URI');
      if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !equal(createHash('sha256').update(verifier).digest('base64url'), record.challenge)) throw new InvalidGrantError('Invalid PKCE verifier');
      this.put('code', hash(code), { ...record, used: true }, record.expires);
      return this.issue(record.grant, client.client_id);
    });
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, token: string, scopes?: string[], resource?: URL) {
    this.audience(resource); this.scopes(scopes);
    const record = this.get<Credential>('refresh', hash(token));
    if (!record || record.client !== client.client_id) throw new InvalidGrantError('Invalid refresh token');
    if (record.used) {
      this.revokeGrant(record.grant);
      throw new InvalidGrantError('Refresh token reuse detected; authorization revoked');
    }
    return this.transaction(() => {
      this.put('refresh', hash(token), { ...record, used: true }, record.expires);
      return this.issue(record.grant, client.client_id);
    });
  }
  async verifyAccessToken(token: string) {
    const record = this.get<Credential>('access', hash(token));
    const grant = record && this.get<Grant>('grant', record.grant);
    if (!record || !grant || grant.revoked) throw new InvalidTokenError('Invalid or expired access token');
    return { token, clientId: record.client, scopes: [SCOPE], expiresAt: record.expires, resource: this.resource };
  }
  private revokeGrant(id: string) {
    const grant = this.get<Grant>('grant', id);
    if (grant) this.put('grant', id, { ...grant, revoked: true }, grant.expires);
  }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    const record = this.get<Credential>('access', hash(request.token)) ?? this.get<Credential>('refresh', hash(request.token));
    if (record?.client === client.client_id) this.revokeGrant(record.grant);
  }
}

export function installOAuth(app: express.Express, config: Config) {
  const provider = new ApiKeyOAuthProvider(config);
  app.use(provider.approvalRouter());
  // Intentionally count direct peer IPs, including behind Coolify. Never trust arbitrary
  // forwarded headers; silence only the SDK limiter's warnings about ignored headers.
  const rateLimit = { validate: { xForwardedForHeader: false, forwardedHeader: false } };
  app.use(mcpAuthRouter({ provider, issuerUrl: provider.issuer, resourceServerUrl: provider.resource, scopesSupported: [SCOPE], resourceName: 'Klotzkette Deutsches Recht MCP', serviceDocumentationUrl: new URL('/guide', provider.issuer),
    authorizationOptions: { rateLimit }, tokenOptions: { rateLimit }, clientRegistrationOptions: { rateLimit }, revocationOptions: { rateLimit },
  }));
  app.locals.stopOAuth = () => provider.close();
  return requireBearerAuth({ verifier: provider, requiredScopes: [SCOPE], expectedResource: provider.resource, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(provider.resource) });
}
