'use strict';

const { ErpClient } = require('./lib/erp-client');

module.exports = function (RED) {
	/**
	 * Connection to one vynst (inwendo ERP) instance: host and API token (JWT).
	 */
	function InwendoErpConfigNode(config) {
		RED.nodes.createNode(this, config);
		this.name = config.name;
		this.host = config.host;
		this.client = new ErpClient({
			host: config.host,
			apiToken: this.credentials ? this.credentials.apiToken : undefined,
		});
	}

	RED.nodes.registerType('inwendo-erp-config', InwendoErpConfigNode, {
		credentials: {
			apiToken: { type: 'password' },
		},
	});

	/**
	 * Token test of the config dialog: /api/base/api_access_token_test?mode=info with the host and
	 * token of the dialog (an unchanged token is read from the deployed node).
	 */
	RED.httpAdmin.post('/inwendo-erp/config/test', RED.auth.needsPermission('inwendo-erp-config.write'), async (req, res) => {
		const body = req.body || {};
		let apiToken = body.apiToken;
		if ((!apiToken || apiToken === '__PWRD__') && body.id) {
			const credentials = RED.nodes.getCredentials(body.id);
			apiToken = credentials ? credentials.apiToken : undefined;
		}
		try {
			const client = new ErpClient({ host: body.host, apiToken, timeout: 15000 });
			const info = await client.request('GET', '/api/base/api_access_token_test', { qs: { mode: 'info' } });
			res.json({ ok: true, info });
		} catch (error) {
			res.json({ ok: false, error: error.message });
		}
	});
};
