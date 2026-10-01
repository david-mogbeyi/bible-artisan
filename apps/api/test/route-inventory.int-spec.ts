import type { Server } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './app';
import { OwnerIsolationProbeModule } from './support/owner-isolation-probe';

type Access =
  | { access: 'public'; why: string }
  | {
      access: 'private';
      /** The integration test file that proves another user gets 404 / only their own data. */
      crossUserTest: string;
    };

/**
 * Every route the production AppModule serves (NFR-SEC-001, AGENTS.md rule 1: "Every new private
 * route gets a cross-user integration test"). This list must match the running app exactly, so
 * adding a route fails CI until it is listed here: as `public` (with a reason, and it must not
 * require a session) or as `private` (naming its cross-user test file, and it must answer 401
 * without a session).
 */
const ROUTES: Record<string, Access> = {
  'GET /v1/health': { access: 'public', why: 'liveness/diagnostics' },
  'GET /v1/openapi.json': { access: 'public', why: 'API description, no user data' },
  'POST /v1/auth/otp/start': { access: 'public', why: 'starts sign-in' },
  'POST /v1/auth/otp/verify': { access: 'public', why: 'completes sign-in' },
  'POST /v1/auth/logout': { access: 'public', why: 'revokes whatever session the cookie names' },
  'GET /v1/me': { access: 'private', crossUserTest: 'owner-isolation.int-spec.ts' },
};

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

/** Method + path of every route mounted on the underlying Express router. */
function mountedRoutes(app: INestApplication<Server>): string[] {
  const express = app.getHttpAdapter().getInstance() as { router: { stack: RouteLayer[] } };
  const routes = new Set<string>();
  for (const layer of express.router.stack) {
    if (!layer.route) continue;
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (enabled && method !== '_all') routes.add(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  return [...routes].sort();
}

/** Fills `:param` segments with a random UUID so the request reaches the route. */
function concretePath(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, () => randomUUID());
}

describe('route inventory', () => {
  let app: INestApplication<Server>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists exactly the routes the app serves', () => {
    expect(mountedRoutes(app)).toStrictEqual(Object.keys(ROUTES).sort());
  });

  it('detects a route that is not listed (the probe app mounts two extra private routes)', async () => {
    const probe = await createTestApp(OwnerIsolationProbeModule);
    try {
      const unlisted = mountedRoutes(probe).filter((route) => !(route in ROUTES));
      expect(unlisted).toStrictEqual([
        'GET /v1/__test/studies/:studyId',
        'GET /v1/__test/studies/:studyId/nodes/:nodeId',
      ]);
    } finally {
      await probe.close();
    }
  });

  it.each(Object.entries(ROUTES).filter(([, entry]) => entry.access === 'private'))(
    '%s requires a session and names an existing cross-user test',
    async (route, entry) => {
      if (entry.access !== 'private') throw new Error('unreachable');
      expect(existsSync(resolve(__dirname, entry.crossUserTest))).toBe(true);
      const [method = '', path = ''] = route.split(' ');
      const res = await request(app.getHttpServer())
        [method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'](concretePath(path))
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(401);
      expect((res.body as { code?: unknown }).code).toBe('UNAUTHENTICATED');
    },
  );

  it.each(Object.entries(ROUTES).filter(([, entry]) => entry.access === 'public'))(
    '%s is reachable without a session',
    async (route) => {
      const [method = '', path = ''] = route.split(' ');
      const res = await request(app.getHttpServer())
        [method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'](concretePath(path))
        .set('Content-Type', 'application/json');
      expect(res.status).not.toBe(401);
    },
  );
});
