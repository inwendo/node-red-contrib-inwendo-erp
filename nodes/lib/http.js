'use strict';

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Raw request body of an HTTP endpoint registered on RED.httpNode. Node-RED parses bodies only for
 * its own "http in" routes, so the stream is normally unread; an already parsed body (custom
 * httpNodeMiddleware) is serialized again, which is fine for JSON but breaks signatures.
 *
 * @returns {Promise<string>}
 */
function readRawBody(req) {
	if (typeof req.rawBody === 'string' || Buffer.isBuffer(req.rawBody)) {
		return Promise.resolve(req.rawBody.toString());
	}
	if (req.body !== undefined) {
		return Promise.resolve(typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body));
	}
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error('request body too large'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

/** Path of a route below httpNodeRoot, joined to the public base URL of Node-RED. */
function publicUrl(baseUrl, httpNodeRoot, path) {
	const base = String(baseUrl || '').trim().replace(/\/+$/, '');
	const root = String(httpNodeRoot || '/').replace(/^\/*/, '/').replace(/\/+$/, '');
	return `${base}${root}${path}`;
}

/**
 * Removes a route that was registered on an express router (Node-RED keeps no handle for it).
 */
function removeRoute(router, path, method) {
	const stack = router && router._router ? router._router.stack : router && router.stack;
	if (!Array.isArray(stack)) {
		return;
	}
	for (let i = stack.length - 1; i >= 0; i--) {
		const route = stack[i].route;
		if (route && route.path === path && route.methods && route.methods[method]) {
			stack.splice(i, 1);
		}
	}
}

module.exports = { readRawBody, publicUrl, removeRoute };
