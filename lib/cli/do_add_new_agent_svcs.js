/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */
var vasync = require('vasync');

var errors = require('../errors');

/*
 * The 'sdcadm experimental add-new-agent-svcs' CLI subcommand.
 */
function do_add_new_agent_svcs(subcmd, opts, args, cb) {
    var self = this;
    var progress = self.progress;
    var execStart = Date.now();

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 1) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    // We need at least a MIN_VALID_SAPI_VERSION image so
    // type=agent suport is there.
    var MIN_VALID_SAPI_VERSION = '20140703';
    var app = self.sdcadm.sdc;

    var img;
    var agentNames = ['vm-agent', 'net-agent', 'cn-agent',
        'agents_core',
        'amon-agent', 'amon-relay', 'cabase', 'cainstsvc', 'config-agent',
        'firewaller', 'hagfish-watcher', 'smartlogin'
    ];
    var agentServices = {};
    agentNames.forEach(function (n) {
        var logLevelKey = n.toUpperCase().replace('-', '_') + '_LOG_LEVEL';
        agentServices[n] = {
            type: 'agent',
            params: {
                tags: {
                    smartdc_role: n,
                    smartdc_type: 'core'
                }
            },
            metadata: {
                SERVICE_NAME: n
            },
            manifests: {
            }
        };

        agentServices[n].metadata[logLevelKey] = 'info';
    });

    var newAgentServices = [];
    // Used by history:
    var history;
    var changes = [];

    vasync.pipeline({funcs: [
        function getSapiVmImgs(_, next) {
            self.sdcadm.getImgsForSvcVms({
                svc: 'sapi'
            }, function (err, obj) {
                if (err) {
                    return next(err);
                }
                img = obj.imgs[0];
                return next();
            });
        },
        function checkMinSapiVersion(_, next) {
            progress('Checking for minimum SAPI version');
            var splitVersion = img.version.split('-');
            var validSapi = false;

            if (splitVersion[0] === 'master') {
                validSapi = splitVersion[1].substr(0, 8) >=
                    MIN_VALID_SAPI_VERSION;
            } else if (splitVersion[0] === 'release') {
                validSapi = splitVersion[1] >= MIN_VALID_SAPI_VERSION;
            }

            if (!validSapi) {
                return next(new errors.SDCClientError(new Error('Datacenter ' +
                    'does not have the minimum SAPI version needed for adding' +
                    ' service agents. ' +
                    'Please try again after upgrading SAPI')));
            }

            return next();
        },

        function checkExistingAgents(_, next) {
            vasync.forEachParallel({
                func: function checkAgentExist(agent, callback) {
                    progress('Checking if service \'%s\' exists', agent);
                    self.sdcadm.sapi.listServices({
                        name: agent,
                        type: 'agent',
                        application_uuid: app.uuid
                    }, function (svcErr, svcs) {
                        if (svcErr) {
                            return callback(svcErr);
                        }
                        if (!svcs.length) {
                            newAgentServices.push(agent);
                        }
                        return callback();
                    });
                },
                inputs: Object.keys(agentServices)
            }, function (err) {
                if (err) {
                    return next(err);
                }
                return next();
            });
        },
        function saveChangesToHistory(_, next) {
            newAgentServices.forEach(function (s) {
                changes.push({
                    service: {
                        name: s,
                        type: 'agent'
                    },
                    type: 'create-service'
                });

            });
            self.sdcadm.history.saveHistory({
                changes: changes
            }, function (err, hst) {
                if (err) {
                    return next(err);
                }
                history = hst;
                return next();
            });
        },
        function addAgentsServices(_, next) {
            vasync.forEachParallel({
                inputs: newAgentServices,
                func: function addAgentSvc(agent, callback) {
                    progress('Adding service for agent \'%s\'', agent);
                    self.log.trace({
                        service: agent,
                        params: agentServices[agent]
                    }, 'Adding new agent service');
                    self.sdcadm.sapi.createService(agent, app.uuid,
                        agentServices[agent], function (err) {
                            if (err) {
                                return callback(err);
                            }
                            return callback();
                    });
                }
            }, function (err) {
                if (err) {
                    return next(err);
                }
                return next();
            });
        }
    ]}, function (err) {
        progress('Add new agent services finished (elapsed %ds).',
            Math.floor((Date.now() - execStart) / 1000));
        if (!history) {
            self.sdcadm.log.warn('History not set for add-new-agent-svcs');
            return cb(err);
        }
        if (err) {
            history.error = err;
        }
        self.sdcadm.history.updateHistory(history, function (err2) {
            if (err) {
                return cb(err);
            } else if (err2) {
                return cb(err2);
            } else {
                return cb();
            }
        });
    });
}

do_add_new_agent_svcs.options = [ {
    names: ['help', 'h'],
    type: 'bool',
    help: 'Show this help.'
}];

do_add_new_agent_svcs.help = (
    'Temporary grabbag for installing the SDC global zone new agents.\n' +
    'The eventual goal is to integrate all of this into "sdcadm update".\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} add-new-agent-svcs\n' +
    '\n' +
    '{{options}}'
);

// --- exports

module.exports = {
    do_add_new_agent_svcs: do_add_new_agent_svcs
};
