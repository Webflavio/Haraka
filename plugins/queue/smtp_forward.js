'use strict';
// Forward to an SMTP server
// Opens the connection to the ongoing SMTP server at queue time
// and passes back any errors seen on the ongoing server to the
// originating server.

var smtp_client_mod = require('./smtp_client');

exports.register = function () {
    var plugin = this;
    var load_config = function () {
        plugin.cfg = plugin.config.get('smtp_forward.ini', {
            booleans: [
                  '-main.enable_tls',
                ],
        },
        load_config);
    };
    load_config();
};

exports.hook_queue = function (next, connection) {
    var plugin = this;
    var cfg = plugin.cfg.main;

    var txn = connection.transaction;
    var rcpt_count = txn.rcpt_to.length;
    if (rcpt_count === 1) {
        var dom = txn.rcpt_to[0].host;
        if (plugin.cfg[dom]) { cfg = plugin.cfg[dom]; }
    }

    connection.loginfo(plugin, 'forwarding to ' + cfg.host + ':' + cfg.port);

    var smc_cb = function (err, smtp_client) {
        smtp_client.next = next;
        var rcpt = 0;

        var send_rcpt = function () {
            if (smtp_client.is_dead_sender(plugin, connection)) { return; }
            if (rcpt === rcpt_count) {
                smtp_client.send_command('DATA');
                return;
            }
            smtp_client.send_command('RCPT', 'TO:' + txn.rcpt_to[rcpt]);
            rcpt++;
        };

        smtp_client.on('mail', send_rcpt);
        if (cfg.one_message_per_rcpt) {
            smtp_client.on('rcpt', function () { smtp_client.send_command('DATA'); });
        }
        else {
            smtp_client.on('rcpt', send_rcpt);
        }

        smtp_client.on('data', function () {
            if (smtp_client.is_dead_sender(plugin, connection)) { return; }
            smtp_client.start_data(txn.message_stream);
        });

        smtp_client.on('dot', function () {
            if (smtp_client.is_dead_sender(plugin, connection)) { return; }
            if (rcpt < rcpt_count) {
                smtp_client.send_command('RSET');
                return;
            }
            smtp_client.call_next(OK, smtp_client.response +
                    ' (' + connection.transaction.uuid + ')');
            smtp_client.release();
        });

        smtp_client.on('rset', function () {
            if (smtp_client.is_dead_sender(plugin, connection)) { return; }
            smtp_client.send_command('MAIL', 'FROM:' + txn.mail_from);
        });

        smtp_client.on('bad_code', function (code, msg) {
            if (smtp_client.is_dead_sender(plugin, connection)) {
                return;
            }
            smtp_client.call_next(((code && code[0] === '5') ? DENY : DENYSOFT),
                                msg + ' (' + connection.transaction.uuid + ')');
            smtp_client.release();
        });
    };

    smtp_client_mod.get_client_plugin(plugin, connection, cfg, smc_cb);
};

exports.hook_queue_outbound = exports.hook_queue;
