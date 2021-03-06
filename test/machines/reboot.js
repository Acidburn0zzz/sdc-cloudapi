/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var test = require('tape').test;
var common = require('../common');
var machinesCommon = require('./common');
var checkJob = machinesCommon.checkJob;
var waitForJob = machinesCommon.waitForJob;

module.exports = function (suite, client, machine, callback) {
    if (!machine) {
        return callback();
    }

    suite.test('RebootMachine', function (t) {
        client.post('/my/machines/' + machine, {
            action: 'reboot'
        }, function (err) {
            t.ifError(err);
            t.end();
        });
    });


    suite.test('Wait For Rebooted', function (t) {
        client.vmapi.listJobs({
            vm_uuid: machine,
            task: 'reboot'
        }, function (err, jobs) {
            t.ifError(err, 'list jobs error');
            t.ok(jobs);
            t.ok(jobs.length);
            waitForJob(client, jobs[0].uuid, function (err2) {
                t.ifError(err2, 'Check state error');
                t.end();
            });
        });
    });
    return callback();
};
