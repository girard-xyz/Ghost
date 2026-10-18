const assert = require('node:assert/strict');
const sinon = require('sinon');
const logging = require('@tryghost/logging');
const BrevoClient = require('../../../../../core/server/lib/brevo/brevo-client');

const makeConfig = ({ apiKey = 'test-api-key', batchSize, targetDeliveryWindow } = {}) => ({
  get(key) {
    if (key === 'bulkEmail') {
      return {
        ...(apiKey ? { brevo: { apiKey } } : {}),
        batchSize,
        targetDeliveryWindow,
      };
    }
    return undefined;
  },
});

const makeResponse = ({ ok = true, status = 201, body = {} } = {}) => ({
  ok,
  status,
  text: async () => (body === null ? '' : JSON.stringify(body)),
});

describe('BrevoClient', function () {
  afterEach(function () {
    sinon.restore();
  });

  describe('send', function () {
    it('sends one message version per recipient with params and traced tags', async function () {
      const fetchStub = sinon
        .stub(globalThis, 'fetch')
        .resolves(makeResponse({ status: 201, body: { messageId: '<20260101@brevo>' } }));
      const client = new BrevoClient({
        config: makeConfig(),
        settings: { get: () => undefined },
      });

      const result = await client.send(
        {
          subject: 'Subject',
          html: '<p>Hi {{params.name_html}}</p>',
          plaintext: 'Hi {{params.name}}',
          from: 'Ghost Newsletter <newsletter@example.com>',
          replyTo: 'reply@example.com',
          tags: ['bulk-email'],
          id: 'email-1',
        },
        {
          'a@example.com': { name: 'Ann', name_html: 'Ann' },
          'b@example.com': { name: 'Bob', name_html: 'Bob' },
        },
        [],
      );

      assert.deepEqual(result, { id: '<20260101@brevo>' });

      sinon.assert.calledOnce(fetchStub);
      const [url, options] = fetchStub.firstCall.args;
      assert.equal(url, 'https://api.brevo.com/v3/smtp/email');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['api-key'], 'test-api-key');

      const body = JSON.parse(options.body);
      assert.deepEqual(body.sender, { email: 'newsletter@example.com', name: 'Ghost Newsletter' });
      assert.deepEqual(body.replyTo, { email: 'reply@example.com' });
      assert.deepEqual(body.tags, ['ghost-email-email-1', 'bulk-email']);
      assert.deepEqual(body.messageVersions, [
        { to: [{ email: 'a@example.com' }], params: { name: 'Ann', name_html: 'Ann' } },
        { to: [{ email: 'b@example.com' }], params: { name: 'Bob', name_html: 'Bob' } },
      ]);
      assert.equal(body.htmlContent, '<p>Hi {{params.name_html}}</p>');
    });

    it('schedules delivery and sets List-Unsubscribe for single-recipient sends', async function () {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(makeResponse({ status: 202 }));
      const client = new BrevoClient({
        config: makeConfig(),
        settings: { get: () => undefined },
      });

      const result = await client.send(
        {
          subject: 'Subject',
          html: 'html',
          plaintext: 'plaintext',
          from: 'ghost@example.com',
          tags: [],
          id: 'email-1',
          deliveryTime: new Date('2026-02-01T10:00:00.000Z'),
        },
        {
          'member@example.com': { list_unsubscribe: 'https://example.com/unsubscribe/one-click' },
        },
        [],
      );

      // Scheduled sends return no message id
      assert.deepEqual(result, { id: null });

      const body = JSON.parse(fetchStub.firstCall.args[1].body);
      assert.equal(body.scheduledAt, '2026-02-01T10:00:00.000Z');
      assert.deepEqual(body.headers, {
        'List-Unsubscribe': '<https://example.com/unsubscribe/one-click>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      });
    });

    it('does not set request headers for multi-recipient sends', async function () {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(makeResponse());
      const client = new BrevoClient({
        config: makeConfig(),
        settings: { get: () => undefined },
      });

      await client.send(
        {
          subject: 'Subject',
          html: 'html',
          plaintext: 'plaintext',
          from: 'ghost@example.com',
          tags: [],
        },
        {
          'a@example.com': { list_unsubscribe: 'https://example.com/unsubscribe/one-click' },
          'b@example.com': { list_unsubscribe: 'https://example.com/unsubscribe/one-click' },
        },
        [],
      );

      const body = JSON.parse(fetchStub.firstCall.args[1].body);
      assert.equal(body.headers, undefined);
      assert.deepEqual(body.tags, ['ghost-email']);
    });

    it('falls back to the per-version message list when no messageId is returned', async function () {
      sinon
        .stub(globalThis, 'fetch')
        .resolves(makeResponse({ status: 201, body: { messageIds: ['<version-1@brevo>'] } }));
      const client = new BrevoClient({
        config: makeConfig(),
        settings: { get: () => undefined },
      });

      const result = await client.send(
        {
          subject: 'Subject',
          html: 'html',
          plaintext: 'plaintext',
          from: 'ghost@example.com',
          tags: [],
        },
        { 'a@example.com': { name: 'Ann' } },
        [],
      );

      assert.deepEqual(result, { id: '<version-1@brevo>' });
    });

    it('rejects with the request payload when Brevo returns an error', async function () {
      sinon
        .stub(globalThis, 'fetch')
        .resolves(makeResponse({ ok: false, status: 400, body: { message: 'Invalid payload' } }));
      const client = new BrevoClient({
        config: makeConfig(),
        settings: { get: () => undefined },
      });

      await assert.rejects(
        client.send(
          {
            subject: 'Subject',
            html: 'html',
            plaintext: 'plaintext',
            from: 'ghost@example.com',
            tags: [],
            id: 'email-1',
          },
          { 'a@example.com': {} },
          [],
        ),
        (err) => {
          assert.equal(err.error.status, 400);
          assert.equal(err.error.message, 'Invalid payload');
          assert.equal(err.messageData.subject, 'Subject');
          return true;
        },
      );
    });

    it('rejects batches larger than the configured batch size', async function () {
      const client = new BrevoClient({
        config: makeConfig({ batchSize: 2 }),
        settings: { get: () => undefined },
      });

      await assert.rejects(
        client.send(
          {
            subject: 'Subject',
            html: 'html',
            plaintext: 'plaintext',
            from: 'ghost@example.com',
            tags: [],
          },
          { 'a@example.com': {}, 'b@example.com': {}, 'c@example.com': {} },
          [],
        ),
        (err) => err.errorType === 'IncorrectUsageError',
      );
    });

    it('returns null when unconfigured', async function () {
      sinon.stub(logging, 'warn');
      const fetchStub = sinon.stub(globalThis, 'fetch');
      const client = new BrevoClient({
        config: makeConfig({ apiKey: null }),
        settings: { get: () => undefined },
      });

      assert.equal(client.isConfigured(), false);
      assert.equal(
        await client.send(
          {
            subject: 'Subject',
            html: 'html',
            plaintext: 'plaintext',
            from: 'ghost@example.com',
            tags: [],
          },
          { 'a@example.com': {} },
          [],
        ),
        null,
      );
      sinon.assert.notCalled(fetchStub);
    });
  });

  describe('getBatchSize', function () {
    it('defaults to 1000 and caps at the Brevo maximum', function () {
      const settings = { get: () => undefined };

      assert.equal(new BrevoClient({ config: makeConfig(), settings }).getBatchSize(), 1000);
      assert.equal(
        new BrevoClient({ config: makeConfig({ batchSize: 300 }), settings }).getBatchSize(),
        300,
      );
      assert.equal(
        new BrevoClient({ config: makeConfig({ batchSize: 5000 }), settings }).getBatchSize(),
        2000,
      );
    });
  });

  describe('fetchEvents', function () {
    const begin = new Date('2026-01-02T00:00:00Z');
    const end = new Date('2026-01-03T00:00:00Z');
    const inWindow = '2026-01-02T10:00:00.000Z';

    const brevoEvent = (overrides) => ({
      email: 'member@example.com',
      messageId: '<1@brevo>',
      date: inWindow,
      tag: 'ghost-email-email-1',
      ...overrides,
    });

    it('maps events, parses the email id from the tag and drops unrelated events', async function () {
      sinon.stub(globalThis, 'fetch').resolves(
        makeResponse({
          body: {
            events: [
              brevoEvent({ event: 'requests' }),
              brevoEvent({ event: 'delivered' }),
              brevoEvent({ event: 'opened' }),
              brevoEvent({ event: 'loadedByProxy' }),
              brevoEvent({ event: 'hardBounces', reason: '550 no such user' }),
              brevoEvent({ event: 'softBounces', reason: 'mailbox full' }),
              brevoEvent({ event: 'blocked', reason: 'recipient blocked' }),
              brevoEvent({ event: 'spam' }),
              brevoEvent({ event: 'unsubscribed' }),
              brevoEvent({ event: 'clicks' }),
              // Before the requested window, day-granularity fetch returns extra events
              brevoEvent({ event: 'delivered', date: '2026-01-01T23:00:00.000Z' }),
            ],
          },
        }),
      );
      const client = new BrevoClient({
        config: makeConfig(),
        settings: { get: () => undefined },
      });
      const batchHandler = sinon.stub().resolves();

      await client.fetchEvents({ begin, end }, batchHandler);

      sinon.assert.calledOnce(batchHandler);
      const events = batchHandler.firstCall.args[0];

      assert.deepEqual(
        events.map((event) => event.type),
        [
          'delivered',
          'opened',
          'opened',
          'failed',
          'failed',
          'failed',
          'complained',
          'unsubscribed',
        ],
      );
      assert.deepEqual(
        events.slice(3, 6).map((event) => event.severity),
        ['permanent', 'temporary', 'permanent'],
      );
      // hard bounce has no dedicated code, blocked reuses Mailgun's suppressed-address code
      assert.equal(events[3].error.code, null);
      assert.equal(events[3].error.message, '550 no such user');
      assert.equal(events[5].error.code, 605);

      assert.equal(events[0].emailId, 'email-1');
      assert.equal(events[0].providerId, '<1@brevo>');
      assert.equal(events[0].recipientEmail, 'member@example.com');
      assert.equal(events[0].timestamp.getTime(), new Date(inWindow).getTime());
      assert.equal(events[0].error, null);
    });

    it("parses the email id from Brevo's comma-joined tag string", async function () {
      sinon.stub(globalThis, 'fetch').resolves(
        makeResponse({
          body: {
            events: [
              brevoEvent({ event: 'delivered', tag: 'ghost-email-email-1,bulk-email' }),
              brevoEvent({ event: 'opened', tag: 'ghost-email,member-welcome-email' }),
            ],
          },
        }),
      );
      const client = new BrevoClient({
        config: makeConfig(),
        settings: { get: () => undefined },
      });
      const batchHandler = sinon.stub().resolves();

      await client.fetchEvents({ begin, end }, batchHandler);

      const events = batchHandler.firstCall.args[0];
      assert.equal(events[0].emailId, 'email-1');
      assert.equal(events[1].emailId, undefined);
    });

    it('keeps only the requested event types', async function () {
      sinon.stub(globalThis, 'fetch').resolves(
        makeResponse({
          body: {
            events: [
              brevoEvent({ event: 'delivered' }),
              brevoEvent({ event: 'opened' }),
              brevoEvent({ event: 'loadedByProxy' }),
            ],
          },
        }),
      );
      const client = new BrevoClient({
        config: makeConfig(),
        settings: { get: () => undefined },
      });
      const batchHandler = sinon.stub().resolves();

      await client.fetchEvents({ begin, end, events: ['opened'] }, batchHandler);

      const events = batchHandler.firstCall.args[0];
      assert.deepEqual(
        events.map((event) => event.type),
        ['opened', 'opened'],
      );
    });

    it('paginates until the window is exhausted and reports no cursor', async function () {
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.onFirstCall().resolves(
        makeResponse({
          body: {
            events: Array.from({ length: 2500 }, (_, i) =>
              brevoEvent({ event: 'delivered', email: `m${i}@example.com` }),
            ),
          },
        }),
      );
      fetchStub
        .onSecondCall()
        .resolves(makeResponse({ body: { events: [brevoEvent({ event: 'delivered' })] } }));
      const client = new BrevoClient({
        config: makeConfig(),
        settings: { get: () => undefined },
      });
      const batchHandler = sinon.stub().resolves();

      const result = await client.fetchEvents({ begin, end }, batchHandler);

      sinon.assert.calledTwice(fetchStub);
      assert.match(fetchStub.secondCall.args[0], /offset=2500/);
      sinon.assert.calledTwice(batchHandler);
      assert.deepEqual(result, {});
    });

    it('stops after the event budget and reports a safe cursor', async function () {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        makeResponse({
          body: {
            events: Array.from({ length: 2500 }, (_, i) =>
              brevoEvent({ event: 'delivered', email: `m${i}@example.com` }),
            ),
          },
        }),
      );
      const client = new BrevoClient({
        config: makeConfig(),
        settings: { get: () => undefined },
      });
      const batchHandler = sinon.stub().resolves();

      const result = await client.fetchEvents({ begin, end }, batchHandler, { maxEvents: 2500 });

      sinon.assert.calledOnce(fetchStub);
      assert.deepEqual(result, { safeCursor: new Date(inWindow) });
    });

    it('returns early when unconfigured', async function () {
      sinon.stub(logging, 'warn');
      const fetchStub = sinon.stub(globalThis, 'fetch');
      const client = new BrevoClient({
        config: makeConfig({ apiKey: null }),
        settings: { get: () => undefined },
      });
      const batchHandler = sinon.stub().resolves();

      const result = await client.fetchEvents({ begin, end }, batchHandler);

      assert.equal(result, undefined);
      sinon.assert.notCalled(fetchStub);
      sinon.assert.notCalled(batchHandler);
    });
  });

  describe('suppression removals', function () {
    it('unblocks the address for all suppression types', async function () {
      const fetchStub = sinon
        .stub(globalThis, 'fetch')
        .resolves(makeResponse({ status: 204, body: null }));
      const client = new BrevoClient({
        config: makeConfig(),
        settings: { get: () => undefined },
      });

      assert.equal(await client.removeBounce('a@example.com'), true);
      assert.equal(await client.removeComplaint('a@example.com'), true);
      assert.equal(await client.removeUnsubscribe('a@example.com'), true);

      sinon.assert.calledThrice(fetchStub);
      assert.equal(
        fetchStub.firstCall.args[0],
        'https://api.brevo.com/v3/smtp/blockedContacts/a%40example.com',
      );
      assert.equal(fetchStub.firstCall.args[1].method, 'DELETE');
    });

    it('treats addresses that are not blocked as removed', async function () {
      sinon
        .stub(globalThis, 'fetch')
        .resolves(makeResponse({ ok: false, status: 404, body: { message: 'Contact not found' } }));
      const client = new BrevoClient({
        config: makeConfig(),
        settings: { get: () => undefined },
      });

      assert.equal(await client.removeBounce('a@example.com'), true);
    });
  });
});
