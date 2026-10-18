// @ts-expect-error This module lacks type definitions.
import BrevoClient from '../../lib/brevo/brevo-client';

type FetchBrevoEventsOptions = {
  config: { get: (key: string) => unknown };
  settings: { get: (key: string) => unknown };
  batchHandler: Function;
  /** Soft maximum. We stop fetching after we reached the maximum AND received at least one event after begin (not equal) to prevent deadlocks. */
  maxEvents?: number;
  begin?: Date;
  end?: Date;
  events?: string[];
};

/**
 * Fetch Brevo email analytics events.
 */
export async function fetchBrevoEvents({
  config,
  settings,
  batchHandler,
  maxEvents,
  begin,
  end,
  events,
}: FetchBrevoEventsOptions) {
  const brevoClient = new BrevoClient({ config, settings });
  return await brevoClient.fetchEvents({ begin, end, events }, batchHandler, { maxEvents });
}
