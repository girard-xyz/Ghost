const BrevoEmailProvider = require('../../../../../core/server/services/email-service/brevo-email-provider');
const sinon = require('sinon');
const logging = require('@tryghost/logging');
const assert = require('node:assert/strict');

describe('Brevo Email Provider', function () {
  describe('send', function () {
    let brevoClient;
    let sendStub;
    let config;

    beforeEach(function () {
      sendStub = sinon.stub().resolves({
        id: '<provider-123@brevo>',
      });

      brevoClient = {
        send: sendStub,
        getBatchSize: sinon.stub().returns(500),
        getTargetDeliveryWindow: sinon.stub().returns(0),
      };
      config = {
        get: sinon.stub(),
      };
    });

    afterEach(function () {
      sinon.restore();
    });

    it('rejects duplicate recipient keys before an accounted provider request', async function () {
      sinon.stub(logging, 'error');
      const provider = new BrevoEmailProvider({ brevoClient, config });
      await assert.rejects(
        provider.send(
          {
            emailId: 'email',
            recipients: [
              {
                email: 'duplicate@example.com',
                replacements: [{ id: 'name', token: '{{name}}', value: 'One' }],
              },
              {
                email: 'duplicate@example.com',
                replacements: [{ id: 'name', token: '{{name}}', value: 'Two' }],
              },
            ],
            replacementDefinitions: [{ id: 'name', token: '{{name}}', getValue: () => 'One' }],
            html: '<html><body>{{name}}</body></html>',
            plaintext: '{{name}}',
            subject: 'Hi',
            from: 'ghost@example.com',
            replyTo: 'ghost@example.com',
          },
          { expectedRecipientCount: 2, batchId: 'batch-1' },
        ),
        (err) => err.code === 'BULK_EMAIL_RECIPIENT_VERIFICATION_FAILED',
      );
      sinon.assert.notCalled(sendStub);
    });

    it('calls brevo client with Brevo variable syntax', async function () {
      const provider = new BrevoEmailProvider({ brevoClient, config });
      const deliveryTime = new Date();

      const response = await provider.send(
        {
          subject: 'Hi',
          html: '<html><body>Hi %%{name}%%</body></html>',
          plaintext: 'Hi %%{name}%%',
          from: 'ghost@example.com',
          replyTo: 'ghost@example.com',
          emailId: '123',
          recipients: [
            {
              email: 'member@example.com',
              replacements: [
                {
                  id: 'name',
                  token: '%%{name}%%',
                  value: 'John',
                },
              ],
            },
          ],
          replacementDefinitions: [
            {
              id: 'name',
              token: '%%{name}%%',
              getValue: () => 'John',
            },
          ],
        },
        {
          clickTrackingEnabled: true,
          openTrackingEnabled: true,
          deliveryTime,
        },
      );

      assert.equal(response.id, 'provider-123@brevo');
      sinon.assert.calledOnce(sendStub);
      sinon.assert.calledWith(
        sendStub,
        {
          subject: 'Hi',
          html: '{% autoescape off %}<html><body>Hi {{params.name_html}}</body></html>{% endautoescape %}',
          plaintext: 'Hi {{params.name}}',
          from: 'ghost@example.com',
          replyTo: 'ghost@example.com',
          tags: ['bulk-email'],
          id: '123',
          deliveryTime,
        },
        { 'member@example.com': { name: 'John', name_html: 'John' } },
        [],
      );
    });

    it('does not html-escape trusted replacements', async function () {
      const provider = new BrevoEmailProvider({ brevoClient, config });

      const unsubscribeUrl = 'http://127.0.0.1:2369/unsubscribe/?uuid=abc&key=def';

      await provider.send(
        {
          subject: 'Hi',
          html: '<html><body><a href="%%{unsubscribe_url}%%">Hi %%{name}%%</a></body></html>',
          plaintext: '%%{unsubscribe_url}%% %%{name}%%',
          from: 'ghost@example.com',
          replyTo: 'ghost@example.com',
          emailId: '123',
          recipients: [
            {
              email: 'member@example.com',
              replacements: [
                {
                  id: 'unsubscribe_url',
                  token: '%%{unsubscribe_url}%%',
                  value: unsubscribeUrl,
                },
                {
                  id: 'name',
                  token: '%%{name}%%',
                  value: '<script>alert(1)</script>',
                },
              ],
            },
          ],
          replacementDefinitions: [
            {
              id: 'unsubscribe_url',
              token: '%%{unsubscribe_url}%%',
              getValue: () => unsubscribeUrl,
              trusted: true,
            },
            {
              id: 'name',
              token: '%%{name}%%',
              getValue: () => '<script>alert(1)</script>',
            },
          ],
        },
        {
          clickTrackingEnabled: true,
          openTrackingEnabled: true,
        },
      );

      const [messageData, recipientData] = sendStub.firstCall.args;

      // The trusted url keeps the plain variable in both bodies, so its query
      // string isn't entity-encoded inside the href
      assert.equal(
        messageData.html,
        '{% autoescape off %}<html><body><a href="{{params.unsubscribe_url}}">Hi {{params.name_html}}</a></body></html>{% endautoescape %}',
      );
      assert.equal(messageData.plaintext, '{{params.unsubscribe_url}} {{params.name}}');
      assert.deepEqual(recipientData, {
        'member@example.com': {
          unsubscribe_url: unsubscribeUrl,
          name: '<script>alert(1)</script>',
          name_html: '&lt;script&gt;alert(1)&lt;/script&gt;',
        },
      });
    });

    it('neutralizes literal template braces in the content', async function () {
      const provider = new BrevoEmailProvider({ brevoClient, config });

      await provider.send(
        {
          subject: 'Hi',
          html: '<html><body>{% tag %} {{ notDefined }}</body></html>',
          plaintext: '{% tag %} {{ notDefined }}',
          from: 'ghost@example.com',
          replyTo: 'ghost@example.com',
          emailId: '123',
          recipients: [{ email: 'member@example.com', replacements: [] }],
          replacementDefinitions: [],
        },
        {},
      );

      const [messageData] = sendStub.firstCall.args;

      assert.equal(
        messageData.html,
        '{% autoescape off %}<html><body>{{"{%"}} tag %} {{"{{"}} notDefined }}</body></html>{% endautoescape %}',
      );
      assert.equal(messageData.plaintext, '{{"{%"}} tag %} {{"{{"}} notDefined }}');
    });

    it('returns a null id when the provider response has no id', async function () {
      sendStub.resolves({ id: null });
      const provider = new BrevoEmailProvider({ brevoClient, config });

      const response = await provider.send(
        {
          html: 'html',
          plaintext: 'plaintext',
          subject: 'Hi',
          from: 'ghost@example.com',
          replyTo: 'ghost@example.com',
          emailId: '123',
          recipients: [
            {
              email: 'member@example.com',
              replacements: [],
            },
          ],
          replacementDefinitions: [],
        },
        {},
      );

      assert.equal(response.id, null);
    });

    it('wraps brevo client rejections in an EmailError', async function () {
      sendStub.rejects({
        error: { status: 400, message: 'Bad request', details: 'invalid sender' },
        messageData: { subject: 'Hi' },
      });
      const provider = new BrevoEmailProvider({ brevoClient, config });

      await assert.rejects(
        provider.send(
          {
            html: 'html',
            plaintext: 'plaintext',
            subject: 'Hi',
            from: 'ghost@example.com',
            replyTo: 'ghost@example.com',
            emailId: '123',
            recipients: [{ email: 'member@example.com', replacements: [] }],
            replacementDefinitions: [],
          },
          {},
        ),
        (err) => {
          assert.equal(err.code, 'BULK_EMAIL_SEND_FAILED');
          assert.equal(err.statusCode, 400);
          assert.match(err.message, /Bad request: invalid sender/);
          return true;
        },
      );
    });
  });

  describe('options', function () {
    it('delegates batch size and delivery window to the brevo client', function () {
      const brevoClient = {
        getBatchSize: sinon.stub().returns(1500),
        getTargetDeliveryWindow: sinon.stub().returns(3600000),
      };
      const provider = new BrevoEmailProvider({ brevoClient, config: { get: sinon.stub() } });

      assert.equal(provider.getMaximumRecipients(), 1500);
      assert.equal(provider.getTargetDeliveryWindow(), 3600000);
    });
  });
});
