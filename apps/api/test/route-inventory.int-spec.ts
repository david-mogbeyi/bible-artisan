import { METHODS, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { type INestApplication, Module, RequestMethod, type Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
import request from 'supertest';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IS_PUBLIC } from '../src/modules/identity/public.decorator';
import { createTestApp } from './app';
import { UNAUTHENTICATED } from './support/envelopes';
import { MutationProbeModule } from './support/mutation-probe';
import { OwnerIsolationProbeModule } from './support/owner-isolation-probe';

/**
 * Names one test that proves another user gets the neutral 404 (or only their own data) on this
 * route. Checked against the spec's syntax tree, not just the file's existence (see
 * `crossUserTestProblems`).
 */
interface CrossUserTest {
  /** Integration spec in this directory, e.g. `owner-isolation.int-spec.ts`. */
  file: string;
  /** The exact title string passed to `it(...)` / `test(...)` / `it.each(...)(...)`. */
  test: string;
}

type Access =
  { access: 'public'; why: string } | { access: 'private'; crossUserTest: CrossUserTest };
type PrivateAccess = Extract<Access, { access: 'private' }>;

const OWNER_ISOLATION = 'owner-isolation.int-spec.ts';

/**
 * Every route the production AppModule serves (NFR-SEC-001, AGENTS.md rule 1: "Every new private
 * route gets a cross-user integration test"). This list must match the running app exactly
 * (`@All()` routes appear as `ALL <path>`), so adding a route fails CI until it is listed here:
 * - `public`: give a reason. The handler or its controller must carry `@Public()`, and the route
 *   must not answer 401 without a session.
 * - `private`: it must answer 401 without a session, and name its cross-user test by file and
 *   exact title. That test must exist as a live `it`/`test` call making a whole-body
 *   `toStrictEqual` assertion, in a spec that references this route's path.
 */
const ROUTES: Record<string, Access> = {
  'GET /v1/health': { access: 'public', why: 'readiness probe, check states only' },
  'GET /v1/health/live': { access: 'public', why: 'liveness probe, no data' },
  'GET /v1/openapi.json': { access: 'public', why: 'API description, no user data' },
  'POST /v1/auth/otp/start': { access: 'public', why: 'starts sign-in' },
  'POST /v1/auth/otp/verify': { access: 'public', why: 'completes sign-in' },
  'POST /v1/auth/logout': { access: 'public', why: 'revokes whatever session the cookie names' },
  'GET /v1/me': {
    access: 'private',
    crossUserTest: { file: OWNER_ISOLATION, test: 'GET /v1/me returns only the signed-in user' },
  },
  // Shared corpus data, not owner-scoped: the cross-user test proves another user gets the same
  // shared reference and nothing user-specific.
  'POST /v1/bible/resolve': {
    access: 'private',
    crossUserTest: {
      file: 'bible-resolve.int-spec.ts',
      test: 'gives another user the same shared reference for the same input',
    },
  },
  // Shared corpus data, not owner-scoped: another user gets the same results.
  'GET /v1/bible/search': {
    access: 'private',
    crossUserTest: {
      file: 'bible-search.int-spec.ts',
      test: 'gives another user the same shared results for the same query',
    },
  },
  // Shared corpus data, not owner-scoped: another user gets the same chapter or edition list.
  'GET /v1/bible/passages': {
    access: 'private',
    crossUserTest: {
      file: 'bible-passages.int-spec.ts',
      test: 'gives another user the same shared chapter for the same request',
    },
  },
  'POST /v1/bible/references': {
    access: 'private',
    crossUserTest: {
      file: 'bible-passages.int-spec.ts',
      test: 'answers 401 without a session and gives another user the same shared reference',
    },
  },
  // Anchors are values over shared corpus data, not owner-scoped: another user gets the same
  // anchor or resolution, and nothing user-specific (BIB-18).
  'POST /v1/bible/anchors': {
    access: 'private',
    crossUserTest: {
      file: 'bible-anchors.int-spec.ts',
      test: 'answers 401 without a session and gives another user the same shared anchor',
    },
  },
  'POST /v1/bible/anchors/resolve': {
    access: 'private',
    crossUserTest: {
      file: 'bible-anchors.int-spec.ts',
      test: 'gives another user the same shared resolution',
    },
  },
  'GET /v1/bible/translations': {
    access: 'private',
    crossUserTest: {
      file: 'bible-passages.int-spec.ts',
      test: 'answers 401 without a session and gives another user the same shared list',
    },
  },
  // Creation has no existing resource to hide: the cross-user test proves receipts are per owner,
  // so another user's identical Idempotency-Key creates their own study, never a replay.
  'POST /v1/studies': {
    access: 'private',
    crossUserTest: {
      file: 'studies.int-spec.ts',
      test: 'POST /v1/studies keeps Idempotency-Keys per owner: another user reusing a key gets their own study',
    },
  },
  'GET /v1/studies/:studyId': {
    access: 'private',
    crossUserTest: {
      file: 'studies.int-spec.ts',
      test: 'GET /v1/studies/:studyId gives another user the same neutral 404 as an absent or malformed id',
    },
  },
};

/** Test-only private routes mounted by the probe modules (never by AppModule). */
const PROBE_ROUTES: Record<string, PrivateAccess> = {
  'GET /v1/__test/studies/:studyId': {
    access: 'private',
    crossUserTest: { file: OWNER_ISOLATION, test: 'gets the neutral 404 for %s' },
  },
  'GET /v1/__test/studies/:studyId/nodes/:nodeId': {
    access: 'private',
    crossUserTest: { file: OWNER_ISOLATION, test: 'gets the neutral 404 for %s' },
  },
  'POST /v1/__test/studies/:studyId/mutations': {
    access: 'private',
    crossUserTest: {
      file: 'mutations.int-spec.ts',
      test: 'gets the neutral 404 when another user mutates a study they do not own',
    },
  },
  'POST /v1/__test/studies/:studyId/nodes/:nodeId/mutations': {
    access: 'private',
    crossUserTest: {
      file: 'mutations.int-spec.ts',
      test: 'gets the neutral 404 when another user mutates a node of a study they do not own',
    },
  },
};

/** Every test-only probe on top of the real AppModule. */
@Module({ imports: [OwnerIsolationProbeModule, MutationProbeModule] })
class AllProbesModule {}

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

/**
 * Method + path of every route mounted on the underlying Express router. An `@All()` route is
 * recorded once as `ALL <path>`: Express 5 mounts it as every method in `http.METHODS` (older
 * routers flag it `_all`), and either form must still fail the inventory until it is listed.
 */
function mountedRoutes(app: INestApplication<Server>): string[] {
  const express = app.getHttpAdapter().getInstance() as { router: { stack: RouteLayer[] } };
  const routes = new Set<string>();
  for (const layer of express.router.stack) {
    if (!layer.route) continue;
    const { path, methods } = layer.route;
    const enabled = Object.keys(methods).filter((method) => methods[method]);
    if (enabled.includes('_all') || METHODS.every((m) => enabled.includes(m.toLowerCase()))) {
      routes.add(`ALL ${path}`);
      continue;
    }
    for (const method of enabled) routes.add(`${method.toUpperCase()} ${path}`);
  }
  return [...routes].sort();
}

interface RouteHandler {
  controller: Type<unknown>;
  handler: (...args: unknown[]) => unknown;
}

/**
 * Method + path → controller class and handler, read from Nest's route metadata (the same
 * metadata the router is built from), so `@Public()` can be read with the Reflector exactly as
 * `SessionGuard` reads it.
 */
function routeHandlers(app: INestApplication<Server>): Map<string, RouteHandler> {
  const scanner = new MetadataScanner();
  const handlers = new Map<string, RouteHandler>();
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as Type<unknown> | null;
      if (!controller) continue;
      const prototype = controller.prototype as Record<string, unknown>;
      const controllerPaths = asArray(Reflect.getMetadata(PATH_METADATA, controller) as unknown);
      for (const name of scanner.getAllMethodNames(prototype)) {
        const handler = prototype[name] as RouteHandler['handler'];
        const methodPaths = asArray(Reflect.getMetadata(PATH_METADATA, handler) as unknown);
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined || methodPaths.length === 0) continue;
        for (const controllerPath of controllerPaths) {
          for (const methodPath of methodPaths) {
            const path = `/v1/${controllerPath}/${methodPath}`
              .replace(/\/+/g, '/')
              .replace(/\/$/, '');
            handlers.set(`${RequestMethod[method]} ${path}`, { controller, handler });
          }
        }
      }
    }
  }
  return handlers;
}

function asArray(value: unknown): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

function isPublic(app: INestApplication<Server>, route: string): boolean {
  const target = routeHandlers(app).get(route);
  if (!target) throw new Error(`no handler metadata for ${route}`);
  return (
    app
      .get(Reflector)
      .getAllAndOverride<boolean | undefined>(IS_PUBLIC, [target.handler, target.controller]) ===
    true
  );
}

/** Fills `:param` segments with a random UUID so the request reaches the route. */
function concretePath(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, () => randomUUID());
}

function call(
  app: INestApplication<Server>,
  route: string,
): ReturnType<ReturnType<typeof request>['get']> {
  const [method = '', path = ''] = route.split(' ');
  const verb = (method === 'ALL' ? 'get' : method.toLowerCase()) as
    'get' | 'post' | 'put' | 'patch' | 'delete';
  return request(app.getHttpServer())
    [verb](concretePath(path))
    .set('Content-Type', 'application/json');
}

/**
 * A regex matching the route's path as a whole string or template literal in a spec: literal
 * segments verbatim, each `:param` either a `${...}` substitution or a concrete segment.
 */
function pathLiteralPattern(path: string): RegExp {
  const segments = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':')
        ? String.raw`(?:\$\{[^}]+\}|[A-Za-z0-9_.~%-]+)`
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    );
  return new RegExp(`^[\`'"]${segments.join('/')}(?:[?\`'"])`);
}

const TEST_FUNCTIONS = new Set(['it', 'test']);
const SKIPPED_CALLEE = /(^x(it|test|describe)\b)|\.(skip|skipIf|runIf|todo|fails)\b/;

/** `it` / `test` (live), or `it.each(table)` / `test.each(table)` (whose result is then called). */
function isTestCallee(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) return TEST_FUNCTIONS.has(callee.text);
  return (
    ts.isCallExpression(callee) &&
    ts.isPropertyAccessExpression(callee.expression) &&
    callee.expression.name.text === 'each' &&
    ts.isIdentifier(callee.expression.expression) &&
    TEST_FUNCTIONS.has(callee.expression.expression.text)
  );
}

/** Every string / template literal inside `node`, as written in the source. */
function literalsIn(node: ts.Node, source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (child: ts.Node): void => {
    if (
      ts.isStringLiteral(child) ||
      ts.isNoSubstitutionTemplateLiteral(child) ||
      ts.isTemplateExpression(child)
    ) {
      found.push(child.getText(source));
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** Every identifier used inside `node`. */
function identifiersIn(node: ts.Node): Set<string> {
  const found = new Set<string>();
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child)) found.add(child.text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/**
 * Why `link` does not point at a real cross-user test for `path` (empty = it does). The spec is
 * parsed with the TypeScript compiler, so a title or path that appears only in a comment does not
 * count. The named test must be a single live (not skipped/todo) `it`/`test` call that makes a
 * whole-body `toStrictEqual` assertion and itself references the route's path: as a literal in
 * the test (its `.each` table included), or through a helper the test calls that is declared in
 * the same file (e.g. `const studyPath = (id) => \`/v1/__test/studies/${id}\``).
 */
function crossUserTestProblems(link: CrossUserTest, path: string): string[] {
  const file = resolve(__dirname, link.file);
  if (!link.file.endsWith('.int-spec.ts') || basename(__filename) === link.file) {
    return [`${link.file} is not another integration spec`];
  }
  if (!existsSync(file)) return [`${link.file} does not exist`];
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );

  const matches: ts.CallExpression[] = [];
  /** Name → declaration, for helpers a test may build the path with. */
  const declarations = new Map<string, ts.Node>();
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name) {
      if (ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
    }
    if (ts.isCallExpression(node) && isTestCallee(node.expression)) {
      const [title] = node.arguments;
      if (
        title &&
        (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title)) &&
        title.text === link.test
      ) {
        matches.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const [match, ...extra] = matches;
  if (!match || extra.length > 0) {
    return [
      `expected exactly one live test titled ${JSON.stringify(link.test)}, found ${matches.length}`,
    ];
  }
  const problems: string[] = [];
  for (let parent = match.parent; !ts.isSourceFile(parent); parent = parent.parent) {
    if (ts.isCallExpression(parent) && SKIPPED_CALLEE.test(parent.expression.getText(source))) {
      problems.push(`the test is inside a skipped block (${parent.expression.getText(source)})`);
    }
  }
  if (!/\.toStrictEqual\(/.test(match.getText(source))) {
    problems.push('the test makes no whole-body toStrictEqual assertion');
  }
  const reachable = [
    ...literalsIn(match, source),
    ...[...identifiersIn(match)].flatMap((name) => {
      const declaration = declarations.get(name);
      return declaration ? literalsIn(declaration, source) : [];
    }),
  ];
  const pattern = pathLiteralPattern(path);
  if (!reachable.some((literal) => pattern.test(literal))) {
    problems.push(`the test never references ${path}`);
  }
  return problems;
}

describe('route inventory', () => {
  let app: INestApplication<Server>;
  let probe: INestApplication<Server>;

  beforeAll(async () => {
    app = await createTestApp();
    probe = await createTestApp(AllProbesModule);
  });

  afterAll(async () => {
    await app.close();
    await probe.close();
  });

  it('lists exactly the routes the app serves', () => {
    expect(mountedRoutes(app)).toStrictEqual(Object.keys(ROUTES).sort());
  });

  it('resolves every mounted route to a handler (so @Public() metadata can be checked)', () => {
    expect([...routeHandlers(app).keys()].sort()).toStrictEqual(mountedRoutes(app));
    expect([...routeHandlers(probe).keys()].sort()).toStrictEqual(mountedRoutes(probe));
  });

  it('detects routes that are not listed (the probe app mounts the probe routes)', () => {
    const unlisted = mountedRoutes(probe).filter((route) => !(route in ROUTES));
    expect(unlisted).toStrictEqual(Object.keys(PROBE_ROUTES).sort());
  });

  const privateRoutes: [string, PrivateAccess, 'app' | 'probe'][] = [
    ...Object.entries(ROUTES).flatMap(([route, entry]): [string, PrivateAccess, 'app'][] =>
      entry.access === 'private' ? [[route, entry, 'app']] : [],
    ),
    ...Object.entries(PROBE_ROUTES).map(([route, entry]): [string, PrivateAccess, 'probe'] => [
      route,
      entry,
      'probe',
    ]),
  ];

  it.each(privateRoutes)(
    '%s requires a session and names a real cross-user test',
    async (route, entry, target) => {
      const server = target === 'app' ? app : probe;
      expect(crossUserTestProblems(entry.crossUserTest, route.split(' ')[1] ?? '')).toStrictEqual(
        [],
      );
      expect(isPublic(server, route)).toBe(false);
      const res = await call(server, route);
      expect(res.status).toBe(401);
      expect(res.body).toStrictEqual(UNAUTHENTICATED);
    },
  );

  it.each(Object.entries(ROUTES).filter(([, entry]) => entry.access === 'public'))(
    '%s carries @Public() and is reachable without a session',
    async (route) => {
      expect(isPublic(app, route)).toBe(true);
      const res = await call(app, route);
      expect(res.status).not.toBe(401);
    },
  );

  describe('the cross-user test check', () => {
    const studyRoute = '/v1/__test/studies/:studyId';

    it('accepts the real link', () => {
      expect(
        crossUserTestProblems(
          { file: OWNER_ISOLATION, test: 'gets the neutral 404 for %s' },
          studyRoute,
        ),
      ).toStrictEqual([]);
    });

    it('refuses a title that is not a test in the named file', () => {
      expect(
        crossUserTestProblems(
          { file: 'health.int-spec.ts', test: 'gets the neutral 404 for %s' },
          studyRoute,
        ),
      ).toStrictEqual([
        'expected exactly one live test titled "gets the neutral 404 for %s", found 0',
      ]);
    });

    it('refuses a real test that never exercises the route, even in a file that does', () => {
      // auth.int-spec.ts calls '/v1/me' in other tests; this one only calls sign-in routes.
      expect(
        crossUserTestProblems(
          {
            file: 'auth.int-spec.ts',
            test: 'refuses a form-encoded start with 415: no code sent, no challenge kept',
          },
          '/v1/me',
        ),
      ).toStrictEqual(['the test never references /v1/me']);
      // The real /v1/me cross-user test is not a cross-user test for the probe study route.
      expect(
        crossUserTestProblems(
          { file: OWNER_ISOLATION, test: 'GET /v1/me returns only the signed-in user' },
          studyRoute,
        ),
      ).toStrictEqual([`the test never references ${studyRoute}`]);
    });

    it('refuses a real test that makes no whole-body assertion', () => {
      expect(
        crossUserTestProblems(
          {
            file: OWNER_ISOLATION,
            test: 'refuses a lock without a transaction (it would protect nothing)',
          },
          studyRoute,
        ),
      ).toStrictEqual([
        'the test makes no whole-body toStrictEqual assertion',
        `the test never references ${studyRoute}`,
      ]);
    });

    it('refuses a missing file and pointing at the inventory itself', () => {
      expect(
        crossUserTestProblems({ file: 'nope.int-spec.ts', test: 'x' }, studyRoute),
      ).toStrictEqual(['nope.int-spec.ts does not exist']);
      expect(
        crossUserTestProblems(
          { file: basename(__filename), test: 'accepts the real link' },
          studyRoute,
        ),
      ).toStrictEqual([`${basename(__filename)} is not another integration spec`]);
    });
  });
});
