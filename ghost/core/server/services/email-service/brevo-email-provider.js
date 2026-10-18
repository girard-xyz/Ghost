const logging = require('@tryghost/logging');
const errors = require('@tryghost/errors');
const debug = require('@tryghost/debug')('email-service:brevo-provider-service');
const { escapeExpression } = require('handlebars');
const {
  RECIPIENT_VERIFICATION_CODE,
  recipientVerificationError,
  countsDiffer,
} = require('./recipient-accounting');

/**
 * @typedef {object} Config
 * @prop {(key: string) => unknown} get
 */

/**
 * @typedef {object} Recipient
 * @prop {string} email
 * @prop {Replacement[]} replacements
 */

/**
 * @typedef {object} Replacement
 * @prop {string} token
 * @prop {string} value
 * @prop {string} id
 */

/**
 * @typedef {object} EmailSendingOptions
 * @prop {boolean} clickTrackingEnabled
 * @prop {boolean} openTrackingEnabled
 * @prop {Date} deliveryTime
 * @prop {number} [expectedRecipientCount]
 * @prop {string} [batchId]
 */

/**
 * @typedef {object} EmailProviderSuccessResponse
 * @prop {string|null} id
 */

class BrevoEmailProvider {
  #brevoClient;
  #config;

  /**
   * @param {object} dependencies
   * @param {import('../../lib/brevo/brevo-client')} dependencies.brevoClient - brevo client to send emails
   * @param {Config} dependencies.config
   */
  constructor({ brevoClient, config }) {
    this.#brevoClient = brevoClient;
    this.#config = config;
  }

  #createRecipientData(replacements, htmlEscapedIds) {
    let recipientData = {};

    recipientData = replacements.reduce((acc, replacement) => {
      const { id, value } = replacement;
      acc[id] = value;
      // Brevo inserts html params raw once auto-escaping is disabled (see below),
      // so member-controlled values get an escaped variant that only the html
      // body points at. Trusted server-generated values (urls, uuids, hmacs) are
      // skipped so their URLs don't end up entity-encoded inside hrefs.
      if (htmlEscapedIds.has(id)) {
        acc[`${id}_html`] = typeof value === 'string' ? escapeExpression(value) : value;
      }
      return acc;
    }, {});

    return recipientData;
  }

  #updateRecipientVariables(data, replacementDefinitions, isHtml) {
    // Brevo renders the body as a Jinja-style template, so literal braces in the
    // content would be parsed as expressions and blanked or executed. They are
    // swapped for template literals, which evaluate back to the same text.
    data = data.replace(/{{|{%|{#/g, (braces) => `{{"${braces}"}}`);

    for (const def of replacementDefinitions) {
      const useHtmlVariant = isHtml && !def.trusted;
      data = data.replace(def.token, `{{params.${def.id}${useHtmlVariant ? '_html' : ''}}}`);
    }
    return data;
  }

  /**
   * Create error message for storing in the database
   * @param {Object} error
   * @param {string} error.message
   * @param {string} error.details
   * @returns {string}
   */
  #createBrevoErrorMessage(error) {
    const message =
      (error?.message || 'Brevo Error') + (error?.details ? ': ' + error.details : '');
    return message.slice(0, 2000);
  }

  /**
   * Send an email using the Brevo API
   * @param {import('./sending-service').EmailData} data
   * @param {EmailSendingOptions} options
   * @returns {Promise<EmailProviderSuccessResponse>}
   */
  async send(data, options) {
    const { subject, html, plaintext, from, replyTo, emailId, recipients, replacementDefinitions } =
      data;

    logging.info(`Sending email to ${recipients.length} recipients`);
    const startTime = Date.now();
    debug(`sending message to ${recipients.length} recipients`);

    try {
      const messageData = {
        subject,
        html,
        plaintext,
        from,
        replyTo,
        tags: ['bulk-email'],
        id: emailId,
      };

      if (options.deliveryTime && options.deliveryTime instanceof Date) {
        messageData.deliveryTime = options.deliveryTime;
      }

      // create recipient data for Brevo using replacement definitions
      const htmlEscapedIds = new Set(
        replacementDefinitions.filter((def) => !def.trusted).map((def) => def.id),
      );
      const recipientData = recipients.reduce((acc, recipient) => {
        acc[recipient.email] = this.#createRecipientData(recipient.replacements, htmlEscapedIds);
        return acc;
      }, {});
      if (
        options.expectedRecipientCount !== undefined &&
        Object.keys(recipientData).length !== options.expectedRecipientCount
      ) {
        const actual = Object.keys(recipientData).length;
        throw recipientVerificationError(
          emailId,
          'provider_payload_count',
          {
            batch_id: options.batchId,
            expected: options.expectedRecipientCount,
            actual,
          },
          {
            countMismatch: countsDiffer(options.expectedRecipientCount, actual),
          },
        );
      }

      // update content to use Brevo variable syntax for all replacements.
      // Brevo html-escapes params by default, which would double-escape the
      // _html variants, so auto-escaping is turned off for the html body. The
      // plaintext body is substituted without escaping.
      if (messageData.html) {
        messageData.html = `{% autoescape off %}${this.#updateRecipientVariables(
          messageData.html,
          replacementDefinitions,
          true,
        )}{% endautoescape %}`;
      }
      if (messageData.plaintext) {
        messageData.plaintext = this.#updateRecipientVariables(
          messageData.plaintext,
          replacementDefinitions,
          false,
        );
      }

      // send the email using Brevo
      // uses empty replacements array as we've already replaced all tokens with Brevo variables
      const response = await this.#brevoClient.send(messageData, recipientData, []);

      debug(`sent message (${Date.now() - startTime}ms)`);
      logging.info(`Sent message (${Date.now() - startTime}ms)`);

      // Return brevo provider id, trim <> from response
      return {
        id: response.id === null ? null : response.id.trim().replace(/^<|>$/g, ''),
      };
    } catch (e) {
      if (e.code === RECIPIENT_VERIFICATION_CODE) {
        throw e;
      }
      let ghostError;
      if (e.error && e.messageData) {
        const { error, messageData } = e;

        ghostError = new errors.EmailError({
          statusCode: error.status,
          message: this.#createBrevoErrorMessage(error),
          errorDetails: JSON.stringify({ error, messageData }),
          context: `Brevo Error ${error.status}: ${error.details}`,
          help: `https://docs.ghost.org/newsletters/#bulk-email-configuration`,
          code: 'BULK_EMAIL_SEND_FAILED',
        });
      } else {
        ghostError = new errors.EmailError({
          statusCode: undefined,
          message: this.#createBrevoErrorMessage(e),
          errorDetails: undefined,
          context: e.context || 'Brevo Error',
          code: 'BULK_EMAIL_SEND_FAILED',
        });
      }

      debug(`failed to send message (${Date.now() - startTime}ms)`);

      throw ghostError;
    }
  }

  getMaximumRecipients() {
    return this.#brevoClient.getBatchSize();
  }

  /**
   * Returns the configured delay between batches in milliseconds
   *
   * @returns {number}
   */
  getTargetDeliveryWindow() {
    return this.#brevoClient.getTargetDeliveryWindow();
  }
}

module.exports = BrevoEmailProvider;
