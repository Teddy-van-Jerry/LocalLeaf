const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rootFolder = [{_id: 'root', name: '', docs: [], fileRefs: [], folders: []}];
function response(status = 200, retryAfter = null) {
    return {
        status,
        headers: {get: name => name === 'retry-after' ? retryAfter : null},
        text: async () => status === 200
            ? '<meta name="ol-projectName" content="Fresh project">' +
                '<meta name="ol-rootFolder" data-type="json" content="' +
                JSON.stringify(rootFolder).replace(/"/g, '&quot;') + '">'
            : 'Too many requests',
    };
}

function harness(responses) {
    let now = Date.parse('2026-10-19T00:00:00Z');
    let timerId = 0;
    const timers = new Map();
    const requests = [];
    const waits = [];
    const context = {
        exports: {}, Buffer, URL,
        Date: class extends Date {static now() {return now;}},
        setTimeout(fn, delay) {
            const id = ++timerId;
            timers.set(id, {fn, at: now + delay});
            return id;
        },
        require(name) {
            if (name === 'node-fetch') return {__esModule: true, default: async (url, options) => {
                requests.push({url, options, at: now});
                const next = responses.shift();
                assert.ok(next, 'unexpected HTTP request');
                if (next instanceof Error) throw next;
                return typeof next === 'function' ? next() : next;
            }};
            return require(name);
        },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../out/api/base.js'), 'utf8'), context);
    const makeApi = (url = 'https://overleaf.example/') => {
        const api = new context.exports.BaseAPI(url);
        api.setIdentity({cookies: 'test-cookie', csrfToken: 'test-csrf'});
        return api;
    };
    const onWait = (delay, limited) => waits.push({delay, limited});
    const settle = async () => {for (let i = 0; i < 40; i++) await Promise.resolve();};
    const run = async promise => {
        let done = false;
        let result;
        let error;
        promise.then(value => {result = value; done = true;}, reason => {error = reason; done = true;});
        for (let i = 0; i < 30 && !done; i++) {
            await settle();
            if (done) break;
            assert.ok(timers.size, 'promise did not settle or schedule a retry');
            const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
            timers.delete(id);
            now = timer.at;
            timer.fn();
        }
        assert.equal(done, true, 'retry loop must terminate');
        if (error) throw error;
        return result;
    };
    return {makeApi, onWait, requests, waits, run, settle, timers, get now() {return now;}};
}

(async () => {
    {
        const h = harness([response(429, '12'), response()]);
        const result = await h.run(h.makeApi().getProjectDetails('project', h.onWait));
        assert.equal(result.type, 'success');
        assert.equal(result.projectData.rootFolder[0]._id, 'root');
        assert.equal(h.requests[1].at - h.requests[0].at, 12000);
        assert.deepEqual(h.waits, [{delay: 12000, limited: true}]);
    }
    {
        const h = harness([response(429, 'Mon, 19 Oct 2026 00:00:20 GMT'), response()]);
        await h.run(h.makeApi().getProjectDetails('project'));
        assert.equal(h.requests[1].at - h.requests[0].at, 20000, 'HTTP-date Retry-After');
    }
    for (const header of [null, '', 'invalid', '-1', '1.5']) {
        const h = harness([response(429, header), response(429, header), response()]);
        const result = await h.run(h.makeApi().getProjectDetails('project'));
        assert.equal(result.type, 'success');
        assert.deepEqual(h.requests.map(r => r.at - h.requests[0].at), [0, 30000, 90000]);
    }
    {
        const h = harness([response(429, '0'), response()]);
        await h.run(h.makeApi().getProjectDetails('project'));
        assert.equal(h.requests[1].at - h.requests[0].at, 5000, 'zero Retry-After must not spin');
    }
    {
        const h = harness([response(429), response(429), response(429)]);
        const result = await h.run(h.makeApi().getProjectDetails('project'));
        assert.equal(result.type, 'error');
        assert.match(result.message, /HTTP 429.*120 seconds/);
        assert.equal(h.requests.length, 3, 'persistent 429 has a bounded retry count');
        assert.equal(h.timers.size, 0);
    }
    {
        const h = harness([response(429, '3600')]);
        const first = await h.run(h.makeApi().getProjectDetails('project'));
        const second = await h.run(h.makeApi().getProjectDetails('project'));
        assert.match(first.message, /3600 seconds/);
        assert.equal(second.type, 'error');
        assert.equal(h.requests.length, 1, 'new API instances respect server cooldowns');
        assert.equal(h.timers.size, 0, 'long Retry-After must not block the command queue');
    }
    {
        let release;
        const h = harness([() => new Promise(resolve => {release = resolve;}), response()]);
        const api = h.makeApi();
        const first = api.getProjectDetails('project');
        const second = h.makeApi().getProjectDetails('other-project');
        await h.settle();
        assert.equal(h.requests.length, 1, 'only one project page may be in flight per server');
        release(response());
        const results = await h.run(Promise.all([first, second]));
        assert.equal(results.every(r => r.type === 'success'), true);
        assert.equal(h.requests[1].at - h.requests[0].at, 5000);
        assert.ok(h.requests[1].url.endsWith('/other-project'));
        assert.equal(h.requests.every(r => r.options.method === 'GET'), true);
    }
    {
        const h = harness([new Error('network lost'), response()]);
        const api = h.makeApi();
        await assert.rejects(h.run(api.getProjectDetails('project')), /network lost/);
        assert.equal((await h.run(api.getProjectDetails('project'))).type, 'success');
    }
    for (const status of [401, 403, 404, 500]) {
        const h = harness([response(status)]);
        const result = await h.run(h.makeApi().getProjectDetails('project'));
        assert.equal(result.type, 'error');
        assert.equal(h.requests.length, 1, 'non-429 errors must not be retried');
        if (status === 401 || status === 403) assert.equal(result.authError, 'session_expired');
    }
    {
        const h = harness([response(), response()]);
        const api = h.makeApi();
        const first = await h.run(api.getProjectDetails('project'));
        const second = await h.run(api.getProjectDetails('project'));
        assert.notEqual(first.projectData, second.projectData, 'never reuse a pre-mutation snapshot');
        assert.equal(h.requests.length, 2);
    }

    // Exercise the actual SyncEngine refresh path with rate-limited HTTP reads.
    {
        const h = harness([response(429, '10'), response(), response(429, '3600'), response()]);
        const statuses = [];
        const logs = [];
        const context = {
            exports: {}, TextEncoder, TextDecoder, Buffer, console,
            require(name) {
                if (name === 'vscode') return {
                    EventEmitter: class {event = () => {}; fire(value) {statuses.push(value);}},
                };
                if (name === './ignoreParser') return {IgnoreParser: class {}};
                return {};
            },
        };
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../out/sync/syncEngine.js'), 'utf8'), context);
        const engine = new context.exports.SyncEngine(h.makeApi(), {
            getSettings: () => ({projectId: 'project'}),
            getWorkspaceFolder: () => ({path: '/test'}),
        }, message => logs.push(message));
        engine.setStatus('pushing');
        await h.run(engine.refreshProjectFileTree());
        assert.equal(engine.fileTreeByPath.get('/').id, 'root');
        assert.ok(logs.some(message => /retrying.*10s/.test(message)));
        assert.equal(statuses.at(-1).status, 'pushing');
        const previousTree = engine.fileTreeByPath.get('/');
        await assert.rejects(h.run(engine.refreshProjectFileTree()), /HTTP 429/);
        assert.equal(engine.fileTreeByPath.get('/'), previousTree, 'failed reads preserve the existing tree');
        engine.api = h.makeApi('https://other.example/');
        engine.disposed = true;
        await assert.rejects(h.run(engine.refreshProjectFileTree()), /cancelled/);
        assert.equal(engine.fileTreeByPath.get('/'), previousTree, 'disposed engines must not apply delayed responses');
    }
    console.log('PASS: project refresh throttling, 429 recovery, Retry-After, bounded retries, fresh snapshots, and sync status');
})().catch(error => {console.error(error); process.exitCode = 1;});
