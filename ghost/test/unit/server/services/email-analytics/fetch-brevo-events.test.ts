import assert from 'node:assert/strict';
import sinon from 'sinon';

// @ts-expect-error This module lacks type definitions.
import BrevoClient from '../../../../../core/server/lib/brevo/brevo-client';
import { fetchBrevoEvents } from '../../../../../core/server/services/email-analytics/fetch-brevo-events';

type FetchBrevoEventsOptions = Parameters<typeof fetchBrevoEvents>[0];

describe('fetchBrevoEvents', function () {
  let config: FetchBrevoEventsOptions['config'];
  let settings: FetchBrevoEventsOptions['settings'];

  beforeEach(function () {
    config = { get() {} };
    settings = { get() {} };
  });

  afterEach(function () {
    sinon.restore();
  });

  it('hands the window and event filter to the brevo client', async function () {
    const fetchEventsStub = sinon.stub(BrevoClient.prototype, 'fetchEvents').resolves({});
    const batchHandler = sinon.stub();
    const begin = new Date('2026-01-01T00:00:00Z');
    const end = new Date('2026-01-01T01:00:00Z');

    const result = await fetchBrevoEvents({
      config,
      settings,
      batchHandler,
      maxEvents: 10000,
      begin,
      end,
      events: ['opened'],
    });

    sinon.assert.calledOnceWithExactly(
      fetchEventsStub,
      { begin, end, events: ['opened'] },
      batchHandler,
      { maxEvents: 10000 },
    );
    assert.deepEqual(result, {});
  });
});
