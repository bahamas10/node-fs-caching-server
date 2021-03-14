/*
 * Basic caching tests
 */

var fs = require('fs');
var http = require('http');
var path = require('path');
var url = require('url');
var util = require('util');

var assert = require('assert-plus');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var test = require('tape');

var lib = require('./lib');
var FsCachingServer = require('../').FsCachingServer;

var f = util.format;
var config = lib.readConfig();

var cachingServerURL = f('http://%s:%d', config.cachingServer.host,
    config.cachingServer.port);
var backendServerURL = f('http://%s:%d', config.backendServer.host,
    config.backendServer.port);

var cachingServer;
var backendServer;

var dir = path.join(__dirname, 'tmp');

/*
 * wrapper for making web requests to the caching server
 */
function cacheRequest(p, opts, cb) {
    assert.string(p, 'p');
    assert.object(opts, 'opts');
    assert.string(opts.method, 'opts.method');
    assert.func(cb, 'cb');

    var uri = f('%s%s', cachingServerURL, p);

    var req = http.request(uri, opts, function (res) {
        var data = '';

        res.setEncoding('utf-8');

        res.on('data', function (d) {
            data += d;
        });

        res.on('end', function () {
            cb(null, data, res);
        });

        res.once('error', function (err) {
            cb(err);
        });
    });

    req.end();
}

/*
 * start the caching frontend
 */
test('start cachingServer', function (t) {
    var opts = {
        cacheDir: dir,
        host: config.cachingServer.host,
        port: config.cachingServer.port,
        backendUrl: backendServerURL
    };

    mkdirp.sync(dir);
    rimraf.sync(dir + '/*');
    t.pass(f('tmp dir "%s" cleared', dir));

    cachingServer = new FsCachingServer(opts);

    cachingServer.once('start', function () {
        t.pass('cachingServer started');
        t.end();
    });

    if (process.env.NODE_DEBUG) {
        cachingServer.on('log', console.log);
    }

    cachingServer.start();
});

/*
 * start the web server backend
 */
test('start backendServer', function (t) {
    backendServer = http.createServer(onRequest);
    backendServer.listen(config.backendServer.port, config.backendServer.host,
        onListen);

    function onRequest(req, res) {
        var p = url.parse(req.url).pathname;
        var s = f('%s request by pid %d at %s\n', p, process.pid, Date.now());

        // handle: /statusCode/<num>
        var matches;
        if ((matches = p.match(/^\/statusCode\/([0-9]+)/))) {
            res.statusCode = parseInt(matches[1], 10);
            res.end(s);
            return;
        }

        switch (p) {
        case '/301.png':
            res.statusCode = 301;
            res.setHeader('Location', '/foo.png');
            res.end();
            break;
        case '/header.png':
            res.setHeader('x-fun-header', 'woo');
            res.end();
        default:
            res.end(s);
            break;
        }
    }

    function onListen() {
        t.pass(f('backendServer started on %s', backendServerURL));
        t.end();
    }
});

/*
 * Basic request that should be cached.
 */
test('simple cached request', function (t) {
    var f = '/hello.png';

    cacheRequest(f, {method: 'GET'}, function (err, webData) {
        t.error(err, 'GET ' + f);

        cachingServer.onIdle(function () {
            // check to make sure the cache has this data
            var fileData = fs.readFileSync(path.join(dir, f), 'utf-8');

            t.equal(webData, fileData, 'file data in sync with web data');

            // request it again to ensure it's correct
            cacheRequest(f, {method: 'GET'}, function (err, webData2) {
                t.error(err, 'GET ' + f);

                t.equal(webData, webData2, 'both web requests same data');

                cachingServer.onIdle(function () {
                    t.end();
                });
            });
        });
    });
});

/*
 * Basic request that should not be cached.
 */
test('simple non-cached request', function (t) {
    var f = '/hello.txt';

    cacheRequest(f, {method: 'GET'}, function (err, webData) {
        t.error(err, 'GET ' + f);

        cachingServer.onIdle(function () {
            // check to make sure the cache DOES NOT have this data
            var file = path.join(dir, f);

            t.throws(function () {
                fs.statSync(file);
            }, file + ' should not exist');

            // request it again to ensure the data is different (time difference)
            cacheRequest(f, {method: 'GET'}, function (err, webData2) {
                t.error(err, 'GET ' + f);

                t.notEqual(webData, webData2, 'both web requests different data');

                cachingServer.onIdle(function () {
                    t.end();
                });
            });
        });
    });
});

/*
 * Codes that *should not* be proxied.
 */
test('statusCodes without proxy', function (t) {
    var codes = [301, 302, 403, 404, 500, 501, 502];
    var idx = 0;

    function go() {
        var code = codes[idx++];
        if (!code) {
            t.end();
            return;
        }
        var uri = f('/statusCode/%d/foo.png', code);

        cacheRequest(uri, {method: 'GET'}, function (err, webData) {
            t.error(err, 'GET ' + uri);
            t.equal(webData, '', 'webData should be empty from caching server');

            cachingServer.onIdle(function () {
                // ensure the file does NOT exist in the cache dir
                var file = path.join(dir, uri);
                t.throws(function () {
                    fs.statSync(file);
                }, file + ' should not exist');

                go();
            });
        });
    }

    go();
});

/*
 * Codes that *should* be proxied.
 */
test('statusCodes with proxy', function (t) {
    var codes = [200];
    var idx = 0;

    function go() {
        var code = codes[idx++];
        if (!code) {
            t.end();
            return;
        }
        var uri = f('/statusCode/%d/foo.png', code);

        cacheRequest(uri, {method: 'GET'}, function (err, webData) {
            t.error(err, 'GET ' + uri);
            t.ok(webData, 'webData should have data from server');

            cachingServer.onIdle(function () {
                // ensure the file exists with the corect data
                var file = path.join(dir, uri);
                var fileData = fs.readFileSync(file, 'utf-8');
                t.equal(webData, fileData, 'file data in sync with web data');

                go();
            });
        });
    }

    go();
});

/*
 * The first request to an item (cache-miss) will result in the request being
 * proxied directly to the backendServer.  Subsequent requests will not be
 * proxied and instead will just be handed the cached file without any of the
 * original headers.
 */
test('headers proxied only on first request', function (t) {
    var uri = '/header.png';
    var serverHeader = 'x-fun-header';

    // initial request (cache miss) should proxy headers from server
    cacheRequest(uri, {method: 'GET'}, function (err, webData, res) {
        t.error(err, 'GET ' + uri);

        var headers = res.headers;
        var customHeader = headers[serverHeader];

        t.equal(customHeader, 'woo', f('custom header %s seen', serverHeader));

        cachingServer.onIdle(function () {
            // second request (cache hit) won't remember headers from server
            cacheRequest(uri, {method: 'GET'}, function (err, webData, res) {
                t.error(err, 'GET ' + uri);

                var headers = res.headers;
                var customHeader = headers[serverHeader];

                t.ok(!customHeader, f('custom header %s not seen', serverHeader));

                cachingServer.onIdle(function () {
                    t.end();
                });
            });
        });
    });
});

/*
 * FsCachingServer handles redirects by specifically choosing to not handle
 * them.  Instead, the statusCodes and headers from the backendServer will be
 * sent directly to the caller, and it is up to that caller if they'd like to
 * follow the redirect.  If the redirects eventually hit a GET or HEAD request
 * that falls within the 200 range, then it will be cached as normal.
 */
test('301 redirect', function (t) {
    var uri = '/301.png';
    var redirect = '/foo.png';

    cacheRequest(uri, {method: 'GET'}, function (err, webData, res) {
        t.error(err, 'GET ' + uri);
        t.ok(!webData, 'body empty');
        t.equal(res.statusCode, 301, '301 seen');
        var headers = res.headers;
        var loc = headers.location;

        t.equal(loc, redirect, 'location is correct');

        cachingServer.onIdle(function () {
            t.end();
        });
    });
});

/*
 * Requesting a directory that exists in the cache should result in a 400.
 */
test('GET directory in cache', function (t) {
    var uri = '/directory.png';

    fs.mkdirSync(path.join(dir, uri));

    cacheRequest(uri, {method: 'GET'}, function (err, webData, res) {
        t.error(err, 'GET ' + uri);
        t.ok(!webData, 'body empty');
        t.equal(res.statusCode, 400, '400 seen');

        cachingServer.onIdle(function () {
            t.end();
        });
    });
});

/*
 * Two simulataneous requests for a cache-miss.  This will result in one of the
 * requests being responsible for downloading the file and getting it streamed
 * to them live, and the other request being paused until the data is fully
 * downloaded.
 *
 * To simulate this fs.stat will be artifically slown down so both requests
 * will block before the cache download begins.
 */
test('Two simultaneous requests', function (t) {
    var originalStat = fs.stat.bind(fs);

    fs.stat = function slowStat(f, cb) {
        setTimeout(function () {
            originalStat(f, cb);
        }, 100);
    };

    var uri = '/simultaneous.png';
    var todo = 2;

    cacheRequest(uri, {method: 'GET'}, requestOne);
    setTimeout(function () {
        cacheRequest(uri, {method: 'GET'}, requestTwo);
    }, 30);

    var data1;
    var data2;

    function requestOne(err, data, res) {
        t.error(err, '1. GET ' + uri);
        data1 = data;

        finish();
    }

    function requestTwo(err, data, res) {
        t.error(err, '2. GET ' + uri);
        data2 = data;

        finish();
    }

    function finish() {
        if (--todo > 0) {
            return;
        }

        fs.stat = originalStat;
        cachingServer.onIdle(function () {
            t.equal(data1, data2, 'data the same');
            t.end();
        });
    }
});

test('close backendServer', function (t) {
    backendServer.once('close', function () {
        t.pass('backendServer closed');
        t.end();
    });
    backendServer.close();
});

test('stop cachingServer', function (t) {
    cachingServer.once('stop', function () {
        t.pass('cachingServer stopped');
        t.end();
    });
    cachingServer.stop();
});
