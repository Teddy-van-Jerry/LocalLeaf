const assert = require('node:assert/strict');
const http = require('node:http');
const {BaseAPI} = require('../out/api/base.js');

(async () => {
    let status = 200;
    let payload = Buffer.from([255, 254, 128, 0, 13, 10]);
    let calls = 0;
    let received;
    let contentType;
    const server = http.createServer((req, res) => {
        calls++;
        const chunks = [];
        req.on('data', data => chunks.push(data));
        req.on('end', () => {
            received = Buffer.concat(chunks);
            contentType = req.headers['content-type'];
            res.writeHead(status);
            res.end(payload);
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const api = new BaseAPI(`http://127.0.0.1:${server.address().port}`).setIdentity({cookies: 'test', csrfToken: 'test'});
    try {
        assert.deepEqual(Buffer.from((await api.getFile('project', 'file')).content), payload);
        for (const code of [401, 403, 404, 429, 500, 302, 206]) {
            status = code;
            const before = calls;
            const result = await api.getFile('project', 'file');
            assert.equal(result.type, 'error', `HTTP ${code} must never become empty content`);
            assert.equal(result.content, undefined);
            assert.equal(calls - before, 1, 'partial downloads must not repeat the same GET indefinitely');
        }
        status = 200;
        payload = Buffer.alloc(0);
        assert.equal((await api.getFile('project', 'file')).content.length, 0, 'legitimate empty files are supported');
        payload = Buffer.from(JSON.stringify({success: true, entity_id: 'uploaded', entity_type: 'file'}));
        const bytes = Uint8Array.from([255, 254, 128, 0, 13, 10]);
        const uploaded = await api.uploadFile('project', 'root', 'figure.pdf', bytes);
        assert.equal(uploaded.file._id, 'uploaded');
        assert.match(contentType, /^multipart\/form-data;\s*boundary=/);
        assert.ok(received.includes(Buffer.from(bytes)), 'multipart body preserves binary bytes exactly');
        payload = Buffer.from(JSON.stringify({success: false, error: 'upload rejected'}));
        const rejected = await api.uploadFile('project', 'root', 'figure.pdf', bytes);
        assert.equal(rejected.type, 'error', 'application-level failure in HTTP 200 is still failure');
        assert.equal(rejected.message, 'upload rejected');
    } finally {
        api.agent.destroy();
        await new Promise(resolve => server.close(resolve));
    }
    console.log('PASS: real HTTP error handling, bounded partial downloads, and byte-exact multipart upload');
})().catch(error => {console.error(error); process.exitCode = 1;});
