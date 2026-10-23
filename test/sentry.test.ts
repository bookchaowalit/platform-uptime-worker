import { describe, expect, it, vi } from 'vitest';
import { scrubEvent, sentryOptions, withOptionalSentry, type SentryEnv, type WorkerHandler } from '../src/sentry';

describe('sentryOptions', () => {
  it('stays disabled when no DSN is configured', () => {
    expect(sentryOptions(undefined).enabled).toBe(false);
  });

  it('reports errors only: no PII, tracing, trace headers or breadcrumbs', () => {
    const options = sentryOptions('https://key@o0.ingest.sentry.io/1');
    expect(options.enabled).toBe(true);
    expect(options.tracesSampleRate).toBe(0);
    expect(options.tracePropagationTargets).toEqual([]);
    expect(options.maxBreadcrumbs).toBe(0);
    expect(options.beforeSendTransaction()).toBe(null);
    expect(options.traceLifecycle).toBe('static');
    expect(options.ignoreSpans).toEqual([/.*/]);
    expect(options.beforeSend).toBe(scrubEvent);
    // SDK v11 equivalent of sendDefaultPii: false.
    expect(options.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
    });
  });
});

describe('scrubEvent', () => {
  it('drops request data, user, breadcrumbs and extra context', () => {
    const event = scrubEvent({
      message: 'boom',
      request: { url: 'https://example.com/p?token=secret', headers: { authorization: 'Bearer secret' } },
      user: { ip_address: '1.2.3.4' },
      breadcrumbs: [{ message: 'fetch' }],
      extra: { body: 'secret' },
    });
    expect(event.message).toBe('boom');
    expect(event.request).toBe(undefined);
    expect(event.user).toBe(undefined);
    expect(event.breadcrumbs).toBe(undefined);
    expect(event.extra).toBe(undefined);
  });

  it('keeps only platform contexts and strips query strings from transaction and tags', () => {
    const event = scrubEvent({
      transaction: 'GET /check?shard=0&token=secret',
      tags: { url: 'https://monitor.test/check?token=secret', route: '/check?token=secret' },
      contexts: { cloud_resource: { 'cloud.account.id': 'acc' }, trace: { trace_id: 't' }, runtime: { name: 'cloudflare' } },
    });
    expect(event.transaction).toBe('GET /check');
    expect(event.tags).toEqual({ route: '/check' });
    expect(event.contexts).toEqual({ runtime: { name: 'cloudflare' } });
    expect(JSON.stringify(event)).not.toContain('secret');
  });

  it('redacts the Telegram bot token from messages and exception values', () => {
    const url = 'https://api.telegram.org/bot123456:AAH-secret_token/sendMessage';
    const event = scrubEvent({
      message: `fetch failed: ${url}`,
      exception: { values: [{ value: `TypeError: ${url}?x=1` }] },
    });
    expect(event.message).toBe('fetch failed: https://api.telegram.org/bot[redacted]/sendMessage');
    expect(event.exception?.values?.[0]?.value).toBe('TypeError: https://api.telegram.org/bot[redacted]/sendMessage');
    expect(JSON.stringify(event)).not.toContain('secret_token');
  });

  it('strips query strings from frames and debug images and removes local variables', () => {
    const event = scrubEvent({
      exception: {
        values: [{ stacktrace: { frames: [{ filename: 'worker.js?v=private', abs_path: '/w.js?q=private', vars: { token: 'p' } }] } }],
      },
      debug_meta: { images: [{ code_file: 'https://example.com/chunk.js?private=1' }] },
    });
    expect(event.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({ filename: 'worker.js', abs_path: '/w.js' });
    expect(event.debug_meta?.images?.[0]?.code_file).toBe('https://example.com/chunk.js');
    expect(JSON.stringify(event)).not.toContain('private');
  });
});

describe('withOptionalSentry', () => {
  const ctx = () => {
    const pending: Promise<unknown>[] = [];
    return {
      ctx: { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext,
      pending,
    };
  };
  const event = { cron: '*/5 * * * *', scheduledTime: 0, type: 'scheduled' } as ScheduledEvent;

  function setup() {
    const order: string[] = [];
    const handler: WorkerHandler<SentryEnv> = {
      fetch: vi.fn(async () => new Response('plain')),
      scheduled: vi.fn(async (_e, _env, c) => {
        c.waitUntil(
          new Promise<void>((resolve) =>
            setTimeout(() => {
              order.push('shard run finished');
              resolve();
            }, 5),
          ),
        );
      }),
    };
    // Stand-in for withSentry: records the options callback and returns the handler it was given.
    const wrap = vi.fn((optionsCallback: (env: SentryEnv) => unknown, wrapped: unknown) => {
      order.push(`wrapped:${JSON.stringify((optionsCallback(env) as { enabled: boolean }).enabled)}`);
      return wrapped;
    });
    const env: SentryEnv = { SENTRY_DSN: 'https://key@o0.ingest.sentry.io/1' };
    const exported = withOptionalSentry(handler, wrap as never);
    return { handler, wrap, exported, order, env };
  }

  it('never touches Sentry without a DSN: the plain handler gets the same arguments', async () => {
    const { handler, wrap, exported } = setup();
    const req = new Request('https://monitor.test/status');
    const c = ctx();
    for (const env of [{}, { SENTRY_DSN: '' }, { SENTRY_DSN: '   ' }]) {
      expect(await (await exported.fetch(req, env, c.ctx)).text()).toBe('plain');
      await exported.scheduled(event, env, c.ctx);
    }
    expect(wrap).not.toHaveBeenCalled();
    expect(handler.fetch).toHaveBeenCalledWith(req, {}, c.ctx);
    // Without a DSN the scheduled work is handed to the real ctx.waitUntil, exactly as before.
    expect((handler.scheduled as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe(c.ctx);
    expect(c.pending.length).toBe(3);
  });

  it('wraps once with a DSN and routes requests through the wrapped handler', async () => {
    const { handler, wrap, exported, env, order } = setup();
    const c = ctx();
    await exported.fetch(new Request('https://monitor.test/'), env, c.ctx);
    await exported.fetch(new Request('https://monitor.test/'), env, c.ctx);
    expect(wrap).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe('wrapped:true');
    expect(handler.fetch).toHaveBeenCalledTimes(2);
  });

  it('with a DSN, the scheduled handler waits for the shard run so its errors reach Sentry', async () => {
    const { exported, env, order } = setup();
    const c = ctx();
    await exported.scheduled(event, env, c.ctx);
    order.push('scheduled returned');
    expect(order.slice(1)).toEqual(['shard run finished', 'scheduled returned']);
    // The run is still registered with the real context.
    expect(c.pending.length).toBe(1);
  });

  it('with a DSN, a failing shard run rejects the scheduled handler', async () => {
    const handler: WorkerHandler<SentryEnv> = {
      fetch: async () => new Response(''),
      scheduled: async (_e, _env, c) => {
        const run = Promise.reject(new Error('KV unavailable'));
        run.catch(() => {});
        c.waitUntil(run);
      },
    };
    const exported = withOptionalSentry(handler, ((_: unknown, h: unknown) => h) as never);
    await expect(exported.scheduled(event, { SENTRY_DSN: 'https://k@o0.ingest.sentry.io/1' }, ctx().ctx)).rejects.toThrow(
      'KV unavailable',
    );
  });
});
