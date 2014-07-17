/*
 * Copyright (c) 2014, Joyent, Inc. All rights reserved.
 *
 * Note retrieving packages using name instead of uuid
 * is deprecated since 7.2.0. (PENDING!):
 *
 * if (semver.satisfies('7.2.0', v) || semver.ltr('7.2.0', v)) {
 * }
 */

var assert = require('assert');
var util = require('util');
var semver = require('semver');
var restify = require('restify');

var cache = require('./cache');
var resources = require('./resources');

// --- Globals

var ResourceNotFoundError = restify.ResourceNotFoundError;
var UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;


// --- Helpers


function translate(req, pkg) {
    assert.ok(req);
    assert.ok(pkg);

    var p = {
        name:   pkg.name,
        memory: pkg.max_physical_memory,
        disk:   pkg.quota,
        swap:   pkg.max_swap,
        vcpus:  pkg.vcpus || 0,
        'default': pkg['default'] || false
    };

    if (!/6\.5/.test(req.getVersion())) {
        p.id = pkg.uuid;
        p.version = pkg.version;

        if (pkg.description) {
            p.description = pkg.description;
        }

        if (pkg.group) {
            p.group = pkg.group;
        }
    }

    return p;
}



// --- Functions
// TODO: this mother needs a refactor

function loadPackages(req, res, next) {
    if (req.url === '/--ping') {
        return next();
    }

    assert.ok(req.account);
    assert.ok(req.sdc.papi);

    var log = req.log;
    var url = req.getUrl();

    req.pkg = false;

    // Given packages list applies its own filters, we'd rather skip it here:
    if (/\/packages$/.test(url.pathname)) {
        return next();
    }

    var ownerUuid = req.account.uuid;
    var pkgName = req.params['package'];

    // If this is a package request by UUID, there's no need to preload anything
    // else.
    if (pkgName) {
        if (UUID_RE.test(pkgName)) {
            return req.sdc.papi.get(pkgName, { owner_uuids: ownerUuid},
                                    function (err, pkg) {
                if (err) {
                    return next(err);
                }

                req.pkg = pkg;
                req.log.debug('load selected package %j', req.pkg);

                return next();
            });

        // If we're trying to retrieve a package by name, we can just search
        // by name in "available" packages:
        } else {
            return req.sdc.papi.list({
                name: pkgName,
                owner_uuids: ownerUuid,
                active: true
            }, {}, function (err, pkgs) {
                if (err) {
                    return next(err);
                }

                if (!pkgs.length) {
                    return next();
                }

                var valid = semver.valid;
                req.pkg = pkgs.reduce(function (a, b) {
                    if (semver.gte(valid(a.version), valid(b.version))) {
                        return a;
                    } else {
                        return b;
                    }
                });

                log.debug('load selected package %j', req.pkg);
                return next();
            });
        }
    }

    // Machines listing:
    // No restrictions at all, given we don't know those when each machine
    // was created.
    if (/\/machines$/.test(url.pathname) &&
        req.method.toLowerCase() !== 'post') {

        return req.sdc.papi.list({}, {}, function (err, pkgs) {
            if (err) {
                return next(err);
            }

            req.packages = pkgs;
            return next();
        });
    }

    if (req.method.toLowerCase() !== 'post' ||
            req.params.action !== 'resize') {
        return next();
    }

    // At this point, we're either a create/resize machine. Ownership and
    // active packages restrictions applied. Also, we need to provide a
    // "default" package for 6.5 provisioning:
    return req.sdc.papi.list({
        owner_uuids: ownerUuid,
        active: true
    }, {}, function (err, pkgs) {
        if (err) {
            return next(err);
        }

        req.packages = pkgs;

        var pkg = pkgs.filter(function (p) {
            return p.default === true;
        });

        if (pkg.length) {
            var valid = semver.valid;

            req.pkg = pkg.reduce(function (a, b) {
                if (semver.gte(valid(a.version), valid(b.version))) {
                    return a;
                } else {
                    return b;
                }
            });

            log.info('load selected package %j', req.pkg);
        }

        return next();
    });
}


function list(req, res, next) {
    if (req.accountMgmt) {
        resources.getRoleTags(req, res);
    }

    var params = req.params;
    var opts = {};

    if (params.name) {
        opts.name = params.name;
    }

    if (req.params.memory) {
        opts.max_physical_memory = params.memory;
    }

    if (req.params.disk) {
        opts.quota = params.disk;
    }

    if (req.params.swap) {
        opts.max_swap = params.swap;
    }

    if (req.params.version) {
        opts.version = params.version;
    }

    if (req.params.vcpus) {
        opts.vcpus = params.vcpus;
    }

    if (req.params.group) {
        opts.group = params.group;
    }

    // We don't want to query the cache if any of the params were set. We only
    // store plain packages based on customer UUID right now.
    var canUseCache = (Object.keys(opts).length === 0);

    opts.active = true;
    opts.owner_uuids = req.account.uuid;

    var cacheKey = getCacheKey(req);

    function sendResult(err, pkgs, saveToCache) {
        if (err) {
            return next(err);
        }

        if (saveToCache) {
            var lifetime = req.config.redis.max_packages_lifetime;  // in sec
            cache.set(req, cacheKey, lifetime, pkgs);
        }

        pkgs = pkgs.map(function (p) {
            return translate(req, p);
        });

        req.log.debug('GET %s => %j', req.path(), pkgs);

        res.send(pkgs);
        return next();
    }

    return cache.get(req, cacheKey, canUseCache, function (err, cachedPkgs) {
        // we treat an err like a cache miss
        if (!err && cachedPkgs) {
            return sendResult(null, cachedPkgs, false);
        }

        return req.sdc.papi.list(opts, {}, function (err2, pkgs) {
            sendResult(err2, pkgs, canUseCache);
        });
    });
}


function get(req, res, next) {
    var log = req.log,
        _p = req.params['package'];

    if (!req.pkg) {
        return next(new ResourceNotFoundError('%s not found', _p));
    }

    if (req.accountMgmt) {
        resources.getRoleTags(req, res);
    }

    var pkg = translate(req, req.pkg);
    log.debug('GET %s => %j', req.path(), pkg);
    res.send(pkg);
    return next();
}


function getCacheKey(req) {
    return 'packages_' + req.account.uuid;
}



function mount(server, before) {
    assert.argument(server, 'object', server);

    server.get({
        path: '/:account/packages',
        name: 'ListPackages'
    }, before || list, before ? list : undefined);

    server.head({
        path: '/:account/packages',
        name: 'HeadPackages'
    }, before || list, before ? list : undefined);

    server.get({
        path: '/:account/packages/:package',
        name: 'GetPackage'
    }, before || get, before ? get : undefined);

    server.head({
        path: '/:account/packages/:package',
        name: 'HeadPackage'
    }, before || get, before ? get : undefined);

    return server;
}



// --- API

module.exports = {
    loadPackages: loadPackages,
    mount: mount
};
