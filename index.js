'use strict';

var TTL = 1000;

/**
 * Assigns transport to the client pipeline
*/
function Trooba() {
    this._handlers = [];
}

Trooba.prototype = {

    use: function use(handler, config) {
        if (typeof handler === 'string') {
            handler = require(handler);
        }

        if (handler instanceof PipePoint) {
            var pipeTo = handler;
            handler = function pipeConnect(pipe) {
                pipe.link(pipeTo);
            };
        }

        this._handlers.push({
            handler: handler,
            config: config
        });

        this._pipe = undefined;
        return this;
    },

    build: function build$(context, interfaceName) {
        if (typeof arguments[0] === 'string') {
            interfaceName = arguments[0];
            context = undefined;
        }
        var pipe = this._pipe;
        if (!pipe) {
            var handlers = this._handlers.slice();
            handlers.unshift(function pipeHead() {});
            pipe = this._pipe = buildPipe(handlers);
        }

        pipe = pipe.create(context || {});
        var factory = interfaceName && pipe.get(interfaceName);
        if (interfaceName && !factory) {
            throw new Error('Cannot find factory for ' + interfaceName);
        }
        return interfaceName ? factory(pipe) : pipe;
    }
};

module.exports.use = function createWithHandler(handler, config) {
    var trooba = new Trooba();
    return trooba.use(handler, config);
};

function buildPipe(handlers) {
    var head;
    var tail = handlers.reduce(function reduce(prev, handlerMeta) {
        var point = createPipePoint(handlerMeta, prev);
        head = head || point;
        return point;
    }, undefined);
    head._tail$ = tail;
    return head;
}
module.exports.buildPipe = buildPipe;

function createPipePoint(handler, prev) {
    var point = new PipePoint(handler);
    if (prev) {
        point._prev$ = prev;
        prev._next$ = point;
    }
    return point;
}

module.exports.createPipePoint = createPipePoint;

var Types = {
    REQUEST: 1,
    RESPONSE: 2
};
module.exports.Types = Types;

var Stages = {
    TRANSIT: 1,
    PROCESS: 2
};
module.exports.Stages = Stages;

/*
* Channel point forms a linked list node
*/
function PipePoint(handler) {
    this._messageHandlers = {};
    this.handler = handler;
    if (handler && typeof handler !== 'function') {
        this.handler = handler.handler;
        this.config = handler.config;
    }
    // build a unique identifer for every new instance of point
    // we do not anticipate creates of so many within one pipe to create conflicts
    PipePoint.instanceCounter = PipePoint.instanceCounter ? PipePoint.instanceCounter : 0;
    this._uid = PipePoint.instanceCounter++;
    this._id = (this.handler ? this.handler.name + '-' : '') + this._uid;
}

module.exports.PipePoint = PipePoint;
module.exports.onDrop = function onDrop(message) {
    console.log('the message has been onDropped, ttl expired:', message.type, message.flow);
};

PipePoint.prototype = {
    send: function send$(message) {
        message.ttl = message.ttl !== undefined ? message.ttl :
            (Date.now() + (this.config && this.config.ttl || TTL));
        if (message.ttl < Date.now()) {
            // onDrop message and let user know
            (this.context && this.context.onDrop || module.exports.onDrop)(message);
            return;
        }

        // pick the direction
        var nextPoint;
        if (message.stage === Stages.PROCESS) {
            nextPoint = this; // stay in this point, needs more processing
        }
        else {
            nextPoint = message.flow === Types.REQUEST ? this._next$ : this._prev$;
            message.stage = Stages.TRANSIT;
        }

        if (nextPoint) {
            message.context = message.context || this.context;
            if (!message.context) {
                throw new Error('Context is missing, make sure context() is used first');
            }
            // forward message down the pipe
            nextPoint.process(message);
        }
        else if (message.type === 'error') {
            throw message.ref;
        }
        else if (message.context && message.context.$strict &&
            message.context.$strict.indexOf(message.type) !== -1) {
            this.copy(message.context).throw(new Error('No target consumer found for the ' +
                message.type + ' ' + JSON.stringify(message.ref)));
        }
        else if (message.type === 'trace' && message.flow === Types.REQUEST) {
            message.flow = Types.RESPONSE;
            this.process(message);
        }

        return this;
    },

    copy: function copy$(context) {
        var ret = new PipePoint();
        ret._next$ = this._next$;
        ret._prev$ = this._prev$;
        ret._tail$ = this._tail$;
        ret._id = this._id;
        ret._messageHandlers = this._messageHandlers;
        ret.config = this.config;
        ret.handler = this.handler;
        ret.context = context;
        ret._points();
        return ret;
    },

    tracer: function tracer$(tracer) {
        this.context.trace = true;
        this.context.tracer$ = tracer;
        return this;
    },

    set: function set$(name, value) {
        this.context['$'+name] = value;
        return this;
    },

    get: function get$(name) {
        return this.context['$'+name];
    },

    link: function link$(pipe) {
        var self = this;
        pipe = pipe.create(this.context);
        this.on('$link$', function onStart(message) {
            if (message.flow === Types.REQUEST) {
                return pipe.send(message); // will be processed first
            }
            message.stage = Stages.PROCESS;
            pipe.tail.send(message);
        });
        pipe.on('$link$', function onEnd(message) {
            if (message.flow === Types.RESPONSE) {
                // send back
                message.stage = Stages.PROCESS;
                return self.send(message);
            }
            pipe.send(message);
        });
        pipe.tail.on('$link$', function onEnd(message) {
            if (message.flow === Types.REQUEST) {
                // send forward
                return self.send(message);
            }
            pipe.tail.send(message);
        });
    },

    trace: function trace$(callback) {
        var self = this;
        this.once('trace', function (list) {
            self.removeListener('error');
            callback(null, list);
        });
        this.once('error', callback);

        this.send({
            type: 'trace',
            flow: Types.REQUEST,
            ref: [{
                point: this,
                flow: Types.REQUEST
            }]
        });
    },

    process: function process$(message) {
        var point = this;
        var messageHandlers;

        // get the hooks
        messageHandlers = this.handlers(message.context);

        var processMessage = messageHandlers.$link$;
        if (processMessage) {
            // for request flow first process through regular hooks if any
            if (message.flow === Types.REQUEST) {
                if (message.stage === Stages.PROCESS) {
                    // after processing, go to the next point
                    message.stage = Stages.TRANSIT;
                    return processMessage(message);
                }
                // make sure the next cycle happens in this point
                message.stage = Stages.PROCESS;
            }
            if (message.flow === Types.RESPONSE) {
                // in response flow it should first go throuh the linked pipe
                if (message.stage === Stages.TRANSIT) {
                    return processMessage(message);
                }
                // make sure it goes to the next point
                message.stage = Stages.TRANSIT;
            }
        }

        if (message.context.trace && message.context.tracer$) {
            message.context.tracer$(message, point);
        }

        if (message.type === 'trace') {
            message.ref.push({
                point: this,
                flow: message.flow,
                stage: message.stage
            });
        }

        var anyType;
        processMessage = messageHandlers[message.type];
        if (!processMessage) {
                processMessage = messageHandlers['*'];
                anyType = true;
        }
        if (processMessage) {
            // if sync delivery, than no callback needed before propagation further
            processMessage(anyType ? message : message.ref,
                    message.sync ? undefined : onComplete);
            if (!message.sync) {
                // on complete would continued the flow
                return;
            }
        }
        else if (processEndEvent()) {
            return;
        }

        point.send(message);

        function onComplete(ref) {
            if (arguments.length) {
                message.ref = ref;
            }
            // special case for stream
            if (processEndEvent()) {
                return;
            }

            point.send(message);
        }

        function processEndEvent() {
            if ((message.type === 'response:data' ||
                message.type === 'request:data') && message.ref === undefined) {

                var endHandler = messageHandlers[
                    message.flow === Types.REQUEST ? 'request:end' : 'response:end'];
                if (endHandler) {
                    endHandler(function onComplete() {
                        point.send(message);
                    });
                    return true;
                }
            }
        }
    },

    /*
    * Create contextual channel
    * context method is a sync method that runs through all handlers
    * to allow them to hook to events they are interested in
    * The context will be attached to every message and bound to pipe
    */
    create: function create$(context) {
        context = context || {};

        if (this.context) {
            // inherit from existing context if any
            var self = this;
            Object.keys(this.context).forEach(function forEach(name) {
                if (name.charAt(0) !== '$' && !context[name]) {
                    context[name] = self.context[name];
                }
            });
        }

        // bind context to the points
        var head = this.copy(context);

        var current = head;
        while(current) {
            current.handler(current, current.config);
            var next = current._next$;
            if (next) {
                next = next.copy(context);
            }
            current = next;
        }

        return head;
    },

    throw: function throw$(err) {
        this.send({
            type: 'error',
            flow: Types.RESPONSE,
            ref: err
        });
    },

    streamRequest: function streamRequest$(request) {
        this.context.$requestStream = true;
        var point = this.request(request);
        var writeStream = createWriteStream({
            channel: point,
            flow: Types.REQUEST
        });
        writeStream.on = function onHook(type, handler) {
            point.on(type, handler);
            return writeStream;
        };
        writeStream.once = function onHook(type, handler) {
            point.once(type, handler);
            return writeStream;
        };
        point.context.$requestStream = writeStream;
        return writeStream;
    },

    request: function request$(request, callback) {
        var point = this;
        if (!point.context) {
            // create default context
            point = point.create({});
        }

        function sendRequest() {
            point.send({
                type: 'request',
                flow: Types.REQUEST,
                ref: request
            });
        }

        if (callback) {
            point
            .on('error', function (err) { callback(err); })
            .on('response', function (res) { callback(null, res); });

            sendRequest();
            return point;
        }

        this.context.$requestStream ? sendRequest() : setTimeout(sendRequest, 0);

        return point;
    },

    respond: function respond$(response) {
        this.send({
            type: 'response',
            flow: Types.RESPONSE,
            ref: response
        });

        return this;
    },

    streamResponse: function streamResponse$(response) {
        this.context.$responseStream = true;
        var point = this.respond(response);

        return this.context.$responseStream = createWriteStream({
            channel: point,
            flow: Types.RESPONSE
        });
    },

    /*
    * Message handlers will be attached to specific context and mapped to a specific point by its _id
    * This is need to avoid re-creating pipe for every new context
    */
    on: function onEvent$(type, handler) {
        var handlers = this.handlers();
        if (handlers[type]) {
            throw new Error('The hook has already been registered, you can use only one hook for specific event type: ' + type + ', point.id:' + this._id);
        }
        handlers[type] = handler;
        return this;
    },

    once: function onceEvent$(type, handler) {
        var self = this;
        this.on(type, function onceFn() {
            delete self.handlers()[type];
            handler.apply(null, arguments);
        });
        return this;
    },

    removeListener: function removeListener$(type) {
        delete this.handlers()[type];
    },

    _points: function _points$(ctx) {
        ctx = ctx || this.context;
        if (!ctx) {
            throw new Error('Context is missing, please make sure context() is used first');
        }
        ctx = ctx.$points = ctx.$points || {};
        ctx = ctx[this._id] = ctx[this._id] || {
            ref: this
        };
        return ctx;
    },

    handlers: function handlers$(ctx) {
        ctx = this._points(ctx);
        ctx._messageHandlers = ctx._messageHandlers || {};
        return ctx._messageHandlers;
    }
};

Object.defineProperty(PipePoint.prototype, 'next', {
    get: function getNext() {
        if (this.context && this._next$) {
            return this._next$._points(this.context).ref;
        }
        return this._next$;
    }
});

Object.defineProperty(PipePoint.prototype, 'prev', {
    get: function getPrev() {
        if (this.context && this._prev$) {
            this._prev$._points(this.context).ref;
        }
        return this._prev$;
    }
});

Object.defineProperty(PipePoint.prototype, 'tail', {
    get: function getPrev() {
        if (this.context && this._tail$) {
            return this._tail$._points(this.context).ref;
        }
        return this._tail$;
    }
});

function createWriteStream(ctx) {
    var type = ctx.flow === Types.REQUEST ? 'request:data' : 'response:data';
    var channel = ctx.channel;

    function _write(data) {
        if (channel._streamClosed) {
            throw new Error('The stream has been closed already');
        }

        if (data === undefined) {
            ctx.channel._streamClosed = true;
        }

        channel.send({
            type: type,
            flow: ctx.flow,
            ref: data
        });
    }

    return {
        write: function write$(data) {
            _write(data);
            return this;
        },

        end: function end$() {
            _write();
            return channel;
        }
    };
}
