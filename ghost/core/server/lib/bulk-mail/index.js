const MailgunClient = require('../mailgun/mailgun-client');
const BrevoClient = require('../brevo/brevo-client');

/**
 * Which bulk email provider is active. Set `bulkEmail.provider` to `'brevo'` in
 * config to switch; anything else (including unset) uses Mailgun.
 *
 * @param {{ get: (key: string) => unknown }} config
 */
const isBrevoSelected = (config) => config.get('bulkEmail:provider') === 'brevo';

/**
 * Returns the configured bulk mail client. Both clients share the same shape:
 * send(), fetchEvents(), removal of suppression entries and the batch size /
 * delivery window getters.
 *
 * @param {{ config: { get: (key: string) => unknown }, settings: { get: (key: string) => unknown } }} deps
 */
const createBulkMailClient = ({ config, settings }) =>
  isBrevoSelected(config)
    ? new BrevoClient({ config, settings })
    : new MailgunClient({ config, settings });

module.exports = { createBulkMailClient, isBrevoSelected };
