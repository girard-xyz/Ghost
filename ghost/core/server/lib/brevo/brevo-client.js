const logging = require('@tryghost/logging');
const errors = require('@tryghost/errors');
const metrics = require('@tryghost/metrics');
const emailAddressParser = require('../../services/email-address/email-address-parser');

const DEFAULT_BATCH_SIZE = 1000;
const MAX_RECIPIENTS_PER_REQUEST = 2000;
const PAGE_LIMIT = 2500;
const REQUEST_TIMEOUT_MS = 60 * 1000;
const API_BASE_URL = 'https://api.brevo.com/v3';

const GHOST_EMAIL_TAG = 'ghost-email';

// Mailgun's "not delivering to a previously bounced address" code. Ghost's
// suppression handling keys on it (and 607), so Brevo's blocked/invalid events
// reuse it to keep hard-bounced members being suppressed.
const SUPPRESSED_ADDRESS_CODE = 605;

// Events Ghost doesn't consume: `requests` (accepted by the API) and `clicks`
// (Ghost tracks clicks itself via link redirects). `loadedByProxy` counts as an
// open for parity with Mailgun, which reports Apple's prefetches as opens.
const EVENT_MAP = {
  delivered: { type: 'delivered' },
  opened: { type: 'opened' },
  loadedByProxy: { type: 'opened' },
  hardBounces: { type: 'failed', severity: 'permanent' },
  blocked: { type: 'failed', severity: 'permanent', code: SUPPRESSED_ADDRESS_CODE },
  invalid: { type: 'failed', severity: 'permanent', code: SUPPRESSED_ADDRESS_CODE },
  softBounces: { type: 'failed', severity: 'temporary' },
  deferred: { type: 'failed', severity: 'temporary' },
  error: { type: 'failed', severity: 'temporary' },
  spam: { type: 'complained' },
  unsubscribed: { type: 'unsubscribed' },
};

const dateOnly = (date) => date.toISOString().slice(0, 10);

// Brevo takes {email, name}; the parser returns {address, name}
const toBrevoAddress = (email) => {
  const parsed = emailAddressParser.parse(email);
  if (!parsed) {
    return { email };
  }
  return { email: parsed.address, ...(parsed.name ? { name: parsed.name } : {}) };
};

const parseEmailIdFromTag = (tag) => {
  if (typeof tag !== 'string') {
    return undefined;
  }
  // Brevo echoes all tags back as one comma-separated string
  const ghostTag = tag.split(',').find((candidate) => candidate.startsWith(`${GHOST_EMAIL_TAG}-`));
  return ghostTag?.slice(GHOST_EMAIL_TAG.length + 1) || undefined;
};

/**
 * Bulk email provider client for Brevo, shaped like `MailgunClient` so the
 * bulk email services can use either client without caring which is active.
 */
module.exports = class BrevoClient {
  #config;
  #settings;

  constructor({ config, settings }) {
    this.#config = config;
    this.#settings = settings;
  }

  #getConfig() {
    const bulkEmailConfig = this.#config.get('bulkEmail');
    if (bulkEmailConfig?.brevo?.apiKey) {
      return bulkEmailConfig.brevo;
    }
    const apiKey = this.#settings?.get?.('brevo_api_key');
    if (apiKey) {
      return { apiKey };
    }
    return null;
  }

  /**
   * Returns whether the Brevo client is configured via config/settings
   *
   * @returns {boolean}
   */
  isConfigured() {
    return !!this.#getConfig();
  }

  /**
   * Returns configured batch size, capped at Brevo's per-request maximum
   *
   * @returns {number}
   */
  getBatchSize() {
    return Math.min(
      this.#config.get('bulkEmail')?.batchSize ?? DEFAULT_BATCH_SIZE,
      MAX_RECIPIENTS_PER_REQUEST,
    );
  }

  /**
   * Returns the configured target delivery window in milliseconds
   * Ghost will attempt to deliver emails evenly distributed over this window
   *
   * Defaults to 0 (no delay) if not set
   *
   * @returns {number}
   */
  getTargetDeliveryWindow() {
    const targetDeliveryWindow = this.#config.get('bulkEmail')?.targetDeliveryWindow;
    if (
      targetDeliveryWindow === undefined ||
      !Number.isInteger(parseInt(targetDeliveryWindow)) ||
      parseInt(targetDeliveryWindow) < 0
    ) {
      return 0;
    }
    return parseInt(targetDeliveryWindow);
  }

  async #api(method, path, body) {
    const brevoConfig = this.#getConfig();
    if (!brevoConfig) {
      throw new errors.IncorrectUsageError({ message: 'Brevo is not configured' });
    }

    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        'api-key': brevoConfig.apiKey,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }

    if (!response.ok) {
      const error = new Error(parsed.message || `Brevo API error ${response.status}`);
      error.status = response.status;
      error.details = parsed.message || text.slice(0, 500);
      throw error;
    }

    return parsed;
  }

  #extractMessageId(response) {
    if (typeof response?.messageId === 'string') {
      return response.messageId;
    }
    if (Array.isArray(response?.messageIds) && typeof response.messageIds[0] === 'string') {
      return response.messageIds[0];
    }
    return null;
  }

  /**
   * Creates the payload and sends to Brevo.
   *
   * recipientData format:
   * {
   *     'test@example.com': {
   *         name: 'Test User',
   *         unsubscribe_url: 'https://example.com/unsub/me',
   *         list_unsubscribe: 'https://example.com/unsub/me'
   *     }
   * }
   *
   * @param {Object} message
   * @param {Object} recipientData
   */
  async send(message, recipientData) {
    if (!this.#getConfig()) {
      logging.warn(`Brevo is not configured`);
      return null;
    }

    const recipients = Object.keys(recipientData);
    const batchSize = this.getBatchSize();
    if (recipients.length > batchSize) {
      throw new errors.IncorrectUsageError({
        message: `Brevo only supports sending to ${batchSize} recipients at a time`,
      });
    }

    const messageVersions = recipients.map((email) => {
      const variables = recipientData[email];
      const params = variables && Object.keys(variables).length > 0 ? variables : undefined;
      return {
        to: [{ email }],
        ...(params ? { params } : {}),
      };
    });

    const tags = [];
    if (message.id) {
      // The id rides in the tag so Brevo events can be traced back to the email
      tags.push(`${GHOST_EMAIL_TAG}-${message.id}`);
    } else {
      tags.push(GHOST_EMAIL_TAG);
    }
    if (Array.isArray(message.tags)) {
      tags.push(...message.tags);
    }

    // Brevo only supports headers per request, so List-Unsubscribe can only be
    // set when the batch is a single recipient (automations), not for newsletters
    const singleRecipient = recipients.length === 1 ? recipientData[recipients[0]] : null;
    const listUnsubscribe = singleRecipient?.list_unsubscribe;
    const headers = listUnsubscribe
      ? {
          'List-Unsubscribe': `<${listUnsubscribe}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        }
      : undefined;

    const messageData = {
      subject: message.subject,
      htmlContent: message.html,
      textContent: message.plaintext,
      sender: toBrevoAddress(message.from),
      ...(message.replyTo ? { replyTo: toBrevoAddress(message.replyTo) } : {}),
      ...(headers ? { headers } : {}),
      tags,
      ...(message.deliveryTime && message.deliveryTime instanceof Date
        ? { scheduledAt: message.deliveryTime.toISOString() }
        : {}),
      messageVersions,
    };

    const startTime = Date.now();
    try {
      const response = await this.#api('POST', '/smtp/email', messageData);
      metrics.metric('brevo-send-mail', {
        value: Date.now() - startTime,
        statusCode: 201,
      });

      return {
        // Single-version sends are attributed by messageId; some responses only
        // carry the per-version list, which is the same thing for one recipient
        id: this.#extractMessageId(response),
      };
    } catch (error) {
      logging.error(error);
      metrics.metric('brevo-send-mail', {
        value: Date.now() - startTime,
        statusCode: error.status,
      });
      return Promise.reject({ error, messageData });
    }
  }

  /**
   * Fetches analytics events and hands them to the batch handler in the shape
   * Ghost's email analytics expect. Brevo only takes day-granularity dates, so
   * events are filtered to the requested window after fetching.
   *
   * @param {Object} options
   * @param {Date} [options.begin]
   * @param {Date} [options.end]
   * @param {string[]} [options.events] - internal event types to keep
   * @param {(events: Object[]) => Promise<void>} batchHandler
   * @param {Object} [options.maxEvents]
   */
  async fetchEvents(
    { begin, end, events: wantedTypes },
    batchHandler,
    { maxEvents = Infinity } = {},
  ) {
    if (!this.#getConfig()) {
      logging.warn(`Brevo is not configured`);
      return;
    }

    const startDate = dateOnly(begin ?? new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
    const endDate = dateOnly(end ?? new Date());
    const wanted = wantedTypes ? new Set(wantedTypes) : null;

    let offset = 0;
    let processed = 0;
    let capped = false;
    let lastEventTimestamp;

    const startTime = Date.now();
    try {
      while (true) {
        const page = await this.#fetchEventsPage({ startDate, endDate, offset });
        const pageEvents = Array.isArray(page.events) ? page.events : [];

        const normalized = pageEvents
          .map((event) => this.normalizeEvent(event))
          .filter((event) => {
            if (!event) {
              return false;
            }
            if (wanted && !wanted.has(event.type)) {
              return false;
            }
            if (begin && event.timestamp < begin) {
              return false;
            }
            if (end && event.timestamp > end) {
              return false;
            }
            return true;
          });

        if (normalized.length > 0) {
          for (const event of normalized) {
            if (!lastEventTimestamp || event.timestamp > lastEventTimestamp) {
              lastEventTimestamp = event.timestamp;
            }
          }
          processed += normalized.length;
          await batchHandler(normalized);
        }

        if (processed >= maxEvents || pageEvents.length < PAGE_LIMIT) {
          capped = processed >= maxEvents && pageEvents.length >= PAGE_LIMIT;
          break;
        }

        offset += PAGE_LIMIT;
      }

      metrics.metric('brevo-get-events', {
        value: Date.now() - startTime,
        statusCode: 200,
      });

      return capped && lastEventTimestamp ? { safeCursor: lastEventTimestamp } : {};
    } catch (error) {
      metrics.metric('brevo-get-events', {
        value: Date.now() - startTime,
        statusCode: error.status,
      });
      throw error;
    }
  }

  async #fetchEventsPage({ startDate, endDate, offset }) {
    const params = new URLSearchParams({
      limit: String(PAGE_LIMIT),
      offset: String(offset),
      startDate,
      endDate,
      sort: 'asc',
    });
    return await this.#api('GET', `/smtp/statistics/events?${params.toString()}`);
  }

  /**
   * Maps a Brevo event onto the shape Ghost's email analytics processors use.
   * Returns null for events with no way to identify the email or recipient.
   *
   * @param {Object} event
   */
  normalizeEvent(event) {
    const mapped = EVENT_MAP[event?.event];
    if (!mapped) {
      return null;
    }

    const emailId = parseEmailIdFromTag(event.tag);
    const providerId = typeof event.messageId === 'string' ? event.messageId : undefined;
    if (!providerId && !emailId) {
      return null;
    }

    return {
      // Brevo has no event id of its own; this is only used for dedupe/diagnostics
      id: `${event.event}:${providerId ?? ''}:${event.email}:${event.date}`,
      type: mapped.type,
      severity: mapped.severity,
      recipientEmail: event.email,
      emailId,
      providerId,
      timestamp: new Date(event.date),
      error:
        mapped.type === 'failed'
          ? {
              code: mapped.code ?? null,
              message: (event.reason || 'Email could not be delivered').substring(0, 2000),
              enhancedCode: null,
            }
          : null,
    };
  }

  async #unblock(email) {
    if (!this.#getConfig()) {
      return false;
    }
    try {
      await this.#api('DELETE', `/smtp/blockedContacts/${encodeURIComponent(email)}`);
      return true;
    } catch (err) {
      if (err.status === 404) {
        // Not blocked in Brevo, nothing to remove
        return true;
      }
      logging.error(err);
      return false;
    }
  }

  /**
   * Brevo blocks addresses at account level rather than by reason, so all three
   * Mailgun suppression types map onto the same "unblock" call.
   */
  async removeBounce(email) {
    return await this.#unblock(email);
  }

  async removeComplaint(email) {
    return await this.#unblock(email);
  }

  async removeUnsubscribe(email) {
    return await this.#unblock(email);
  }
};
