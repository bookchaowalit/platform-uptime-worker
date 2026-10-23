/// <reference types="@cloudflare/workers-types" />

// Sentry error reporting for the Worker. Copied from the shared reference
// (~/work/b-tier-b/sentry-ref/sentry.ts) and adapted here; this repo owns its copy.
//
// Errors only (SDK v11: `dataCollection` all off is the old `sendDefaultPii: false`): no tracing, no trace headers on outgoing requests, no breadcrumbs, and nothing that
// can carry user input (URLs, query strings, headers, cookies, bodies, locals). The Telegram bot
// token sits in the sendMessage URL path, so `/bot<token>` is redacted from any text as well.
//
// Without a SENTRY_DSN Worker secret none of the Sentry code runs: `withOptionalSentry` hands every
// event straight to the plain handler, so the monitor behaves exactly as it did before Sentry.

import { withSentry } from '@sentry/cloudflare';

type Frame = { vars?: unknown; filename?: string; abs_path?: string };
type ScrubbableEvent = {
  message?: string;
  request?: unknown;
  user?: unknown;
  breadcrumbs?: unknown;
  extra?: unknown;
  transaction?: string;
  tags?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  exception?: { values?: { value?: string; stacktrace?: { frames?: Frame[] } }[] };
  debug_meta?: { images?: { code_file?: string }[] };
};

// Contexts that describe the platform only. Everything else (`trace`, `response`, cloud resource
// details) is dropped.
const SAFE_CONTEXTS = ['os', 'runtime', 'browser', 'device', 'app'];

const stripQuery = (value: string) => value.split(/[?#]/)[0];
// Drops ?query and #hash from every URL or absolute path inside free text, e.g. an error message.
const stripUrlQueries = (text: string) => text.replace(/((?:https?:\/\/|\/)[^\s?#"'<>()]*)[?#][^\s"'<>()]*/g, '$1');
// Telegram bot tokens look like `/bot123456:AAH...` in api.telegram.org URLs.
const redactBotTokens = (text: string) => text.replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot[redacted]');
const scrubText = (text: string) => redactBotTokens(stripUrlQueries(text));

export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  delete event.request;
  delete event.user;
  delete event.breadcrumbs;
  delete event.extra;
  if (event.contexts) {
    const kept: Record<string, unknown> = {};
    for (const key of SAFE_CONTEXTS) if (key in event.contexts) kept[key] = event.contexts[key];
    event.contexts = kept;
  }
  if (typeof event.message === 'string') event.message = scrubText(event.message);
  if (typeof event.transaction === 'string') event.transaction = redactBotTokens(stripQuery(event.transaction));
  if (event.tags) {
    delete event.tags.url;
    for (const [key, value] of Object.entries(event.tags)) {
      if (typeof value === 'string') event.tags[key] = redactBotTokens(stripQuery(value));
    }
  }
  for (const value of event.exception?.values ?? []) {
    if (typeof value.value === 'string') value.value = scrubText(value.value);
    for (const frame of value.stacktrace?.frames ?? []) {
      delete frame.vars;
      if (typeof frame.filename === 'string') frame.filename = stripQuery(frame.filename);
      if (typeof frame.abs_path === 'string') frame.abs_path = stripQuery(frame.abs_path);
    }
  }
  for (const image of event.debug_meta?.images ?? []) {
    if (typeof image.code_file === 'string') image.code_file = stripQuery(image.code_file);
  }
  return event;
}

export function sentryOptions(dsn: string | undefined) {
  return {
    dsn,
    enabled: Boolean(dsn),
    // SDK v11 replaced `sendDefaultPii` with `dataCollection`; this is its "send no PII" setting:
    // collect no user info, cookies, headers, query params, bodies or local variables.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    // 0 rather than undefined: the Cloudflare SDK falls back to a SENTRY_TRACES_SAMPLE_RATE binding
    // when this is undefined, and this Worker must never send traces.
    tracesSampleRate: 0,
    tracePropagationTargets: [] as string[],
    maxBreadcrumbs: 0,
    beforeSend: scrubEvent,
    // `static` so beforeSendTransaction applies (the v11 default `stream` ignores it); ignoreSpans
    // drops every span in either mode. No trace data ever leaves the Worker.
    traceLifecycle: 'static' as const,
    ignoreSpans: [/.*/],
    beforeSendTransaction: () => null,
  };
}

export interface SentryEnv {
  SENTRY_DSN?: string;
}

export interface WorkerHandler<E extends SentryEnv> {
  fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response>;
  scheduled(event: ScheduledEvent, env: E, ctx: ExecutionContext): Promise<void>;
}

/**
 * Wraps the Worker handler with Sentry only when SENTRY_DSN is set. Without it every call goes to
 * `handler` untouched and the Sentry SDK is never initialised.
 *
 * With a DSN, the scheduled handler also waits for the work it passed to `ctx.waitUntil`, so an error
 * in a shard run reaches Sentry before the client is flushed (the cron outcome is the same: the run
 * still has to finish inside the invocation).
 */
export function withOptionalSentry<E extends SentryEnv>(
  handler: WorkerHandler<E>,
  wrap: typeof withSentry = withSentry,
): WorkerHandler<E> {
  let instrumented: WorkerHandler<E> | undefined;
  const sentried = () =>
    (instrumented ??= wrap((env: E) => sentryOptions(env.SENTRY_DSN?.trim() || undefined), {
      fetch: (request: Request, env: E, ctx: ExecutionContext) => handler.fetch(request, env, ctx),
      scheduled: async (event: ScheduledEvent, env: E, ctx: ExecutionContext) => {
        const pending: Promise<unknown>[] = [];
        const tracked: ExecutionContext = {
          waitUntil: (promise: Promise<unknown>) => {
            pending.push(promise);
            ctx.waitUntil(promise);
          },
          passThroughOnException: () => ctx.passThroughOnException(),
          props: ctx.props,
        } as ExecutionContext;
        await handler.scheduled(event, env, tracked);
        await Promise.all(pending);
      },
    } as ExportedHandler<E>) as unknown as WorkerHandler<E>);
  const enabled = (env: E) => Boolean(env.SENTRY_DSN?.trim());

  return {
    fetch: (request, env, ctx) => (enabled(env) ? sentried().fetch(request, env, ctx) : handler.fetch(request, env, ctx)),
    scheduled: (event, env, ctx) =>
      enabled(env) ? sentried().scheduled(event, env, ctx) : handler.scheduled(event, env, ctx),
  };
}
