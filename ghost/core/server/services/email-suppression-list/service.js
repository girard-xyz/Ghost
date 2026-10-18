const models = require('../../models');
const configService = require('../../../shared/config');
const settingsCache = require('../../../shared/settings-cache');
const { createBulkMailClient } = require('../../lib/bulk-mail');
const MailgunEmailSuppressionList = require('./mailgun-email-suppression-list');

// Duck-typed on purpose: both the Mailgun and Brevo clients expose
// removeBounce / removeComplaint / removeUnsubscribe
const apiClient = createBulkMailClient({
  config: configService,
  settings: settingsCache,
});

module.exports = new MailgunEmailSuppressionList({
  Suppression: models.Suppression,
  apiClient,
});
