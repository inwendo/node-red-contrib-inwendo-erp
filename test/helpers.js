'use strict';

const http = require('http');
const net = require('net');

/**
 * A small stand-in for the inwendo ERP: records every request and answers with the handler of its route.
 */
async function startErpMock(routes) {
	const requests = [];
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', () => {
			const url = new URL(req.url, 'http://localhost');
			const text = Buffer.concat(chunks).toString('utf8');
			const request = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: text ? JSON.parse(text) : undefined };
			requests.push(request);
			const handler = routes[`${req.method} ${url.pathname}`];
			const answer = handler ? handler(request) : { status: 404, body: { error: 'no route' } };
			res.writeHead(answer.status || 200, { 'Content-Type': answer.contentType || 'application/json', ...(answer.headers || {}) });
			res.end(Buffer.isBuffer(answer.body) ? answer.body : JSON.stringify(answer.body === undefined ? {} : answer.body));
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		host: `http://127.0.0.1:${server.address().port}`,
		requests,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

async function startMqttBroker() {
	const aedes = require('aedes')();
	const server = net.createServer(aedes.handle);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		url: `mqtt://127.0.0.1:${server.address().port}`,
		aedes,
		publish: (topic, payload) => new Promise((resolve, reject) => aedes.publish({ topic, payload: Buffer.from(payload), qos: 0, retain: false }, (error) => (error ? reject(error) : resolve()))),
		close: () => new Promise((resolve) => aedes.close(() => server.close(resolve))),
	};
}

function waitFor(predicate, timeoutMs = 3000) {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const check = () => {
			let value;
			try {
				value = predicate();
			} catch (error) {
				value = undefined;
			}
			if (value) {
				resolve(value);
			} else if (Date.now() - started > timeoutMs) {
				reject(new Error('timeout'));
			} else {
				setTimeout(check, 20);
			}
		};
		check();
	});
}

module.exports = { startErpMock, startMqttBroker, waitFor };
