// Copyright 2013 Joyent, Inc. All rights reserved.

var test = require('tap').test;
var uuid = require('node-uuid');
var common = require('../common');
var machinesCommon = require('./common');
var checkJob = machinesCommon.checkJob;
var waitForJob = machinesCommon.waitForJob;
var TAP_CONF = {
    timeout: 'Infinity '
};

module.exports = function (suite, client, machine, pkg, callback) {
    if (!machine) {
        return callback();
    }

    suite.test('Resize Machine', TAP_CONF, function (t) {
        t.ok(pkg, 'Resize package OK');
        console.log('Resizing to package: %j', pkg);
        client.post('/my/machines/' + machine, {
            action: 'resize',
            'package': pkg.name
        }, function (err) {
            t.ifError(err, 'Resize machine error');
            t.end();
        });
    });


    suite.test('Wait For Resized', TAP_CONF,  function (t) {
        client.vmapi.listJobs({
            vm_uuid: machine,
            task: 'update'
        }, function (err, jobs) {
            t.ifError(err, 'list jobs error');
            t.ok(jobs, 'list jobs OK');
            t.ok(jobs.length, 'update jobs is array');
            var resize_jobs = jobs.filter(function (job) {
                return (
                    typeof (job.params.max_physical_memory) !== 'undefined');
            });
            t.ok(resize_jobs.length, 'resize jobs is an array');
            waitForJob(client, resize_jobs[0].uuid, function (err2) {
                t.ifError(err2, 'Check state error');
                t.end();
            });
        });
    });

    return callback();
};
