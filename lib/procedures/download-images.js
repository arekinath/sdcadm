/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var p = console.log;
var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var util = require('util'),
    format = util.format;
var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors'),
    InternalError = errors.InternalError;

var Procedure = require('./procedure').Procedure;

function DownloadImages(options) {
    assert.arrayOfObject(options.images, 'options.images');
    this.images = options.images;
}
util.inherits(DownloadImages, Procedure);

DownloadImages.prototype.summarize = function diSummarize() {
    var size = this.images.map(function (img) {
        return (img.files.length ? img.files[0].size : 0);
    }).reduce(function (prev, curr) {
        return prev + curr;
    });
    var imageInfos = this.images.map(function (img) {
        return format('image %s\n    (%s@%s)', img.uuid, img.name, img.version);
    });
    return sprintf('download %d image%s (%d MiB):\n%s',
        this.images.length,
        (this.images.length === 1 ? '' : 's'),
        size / 1024 / 1024,
        common.indent(imageInfos.join('\n')));
};

/**
 * The 'source' URL (IMGAPI endpoint) can optionally be passed in. It defaults
 * to 'updates.joyent.com?channel=<current-channel>'.
 */
DownloadImages.prototype.execute = function diExecute(options, cb) {
    assert.object(options, 'options');
    assert.object(options.sdcadm, 'options.sdcadm');
    assert.object(options.log, 'options.log');
    assert.optionalString(options.source, 'options.source');
    assert.func(options.progress, 'options.progress');
    assert.func(cb, 'cb');
    var self = this;
    var sdcadm = options.sdcadm;
    var progress = options.progress;

    var source = options.source;
    if (!source) {
        source = sdcadm.config.updatesServerUrl;
        if (sdcadm.updates.channel) {
            source += '?channel=' + sdcadm.updates.channel;
        }
    }


    var q = vasync.queuev({
        concurrency: 4,
        worker: function importUpdateImage(image, next) {
            function deleteImage(_, nextStep) {
                if (image.state !== 'unactivated') {
                    return nextStep();
                }

                progress('Removing unactivated image %s\n(%s@%s)', image.uuid,
                    image.name, image.version);

                sdcadm.imgapi.deleteImage(image.uuid, function (err) {
                    if (err) {
                        progress('Error removing unactivated image %s\n(%s@%s)',
                                    image.uuid, image.name, image.version);

                        var e = new errors.SDCClientError(err, 'imgapi');
                        e.image = image.uuid;
                        sdcadm.log.error({err: e}, 'Error removing image');
                        nextStep(e);
                    } else {
                        nextStep();
                    }
                });
            }

            function getImage(_, nextStep) {
                progress('Downloading image %s\n    (%s@%s)',
                    image.uuid, image.name, image.version);
                sdcadm.imgapi.adminImportRemoteImageAndWait(
                    image.uuid,
                    source,
                    {
                        // TODO: Once IMGAPI-408 is sufficient deployed, then
                        // drop this `skipOwnerCheck`.
                        skipOwnerCheck: true,
                        // Retry image import 5 times by default:
                        retries: 5
                    },
                    function (err, img, res) {
                        if (err) {
                            progress('Error importing image %s\n(%s@%s)',
                                image.uuid, image.name, image.version);
                            var e = new errors.SDCClientError(err, 'imgapi');
                            e.image = image.uuid;
                            nextStep(e);
                        } else {
                            progress('Imported image %s\n    (%s@%s)',
                                image.uuid, image.name, image.version);
                            nextStep();
                        }
                    });
            }

            vasync.pipeline({funcs: [deleteImage, getImage]}, next);
        }
    });

    // TODO: For now we just collect import errors and return them. We
    //       should do better with retries (either here or in the imgapi
    //       client).
    var errs = [];
    function onTaskComplete(err) {
        if (err) {
            errs.push(err);
        }
    }

    q.on('end', function done() {
        var er = (errs.length === 1) ? errs[0] :
            new errors.MultiError(errs);

        // Check if the problem is that external nics are missing.
        if (errs.length) {
            var remoteSourceErr = errs.some(function (e) {
                return (e && e.we_cause &&
                    e.we_cause.name === 'RemoteSourceError');
            });

            if (remoteSourceErr) {
                options.sdcadm.checkMissingExternalNics({
                    progress: options.progress
                }, function (err, res) {
                    if (err) {
                        return cb(errs);
                    }

                    var doimgapi = res.doimgapi;
                    if (doimgapi) {
                        p('');
                        var msg = 'There is an error trying to download ' +
                            'images because the imgapi zone has no ' +
                            'external NIC.\nPlease run:\n\n' +
                            '   sdcadm post-setup common-external-nics\n' +
                            '\nand try again.\n';
                        p(msg);
                    }
                    // we need to return the error anyway:
                    return cb(er);
                });
            } else {
                cb(er);
            }
        } else {
            cb();
        }
    });

    for (var i = 0; i < self.images.length; i++) {
        q.push(self.images[i], onTaskComplete);
    }
    q.close();
};

//---- exports

module.exports = {
    DownloadImages: DownloadImages
};
// vim: set softtabstop=4 shiftwidth=4:
