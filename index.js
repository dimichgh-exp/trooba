'use strict';

var TTL = 15000;

/**
 * Assigns transport to the client pipeline
*/
function Trooba() {
    this._handlers = [];
}

Trooba.prototype = {

    use: function use(handler, config) {
        if (typeof handler === 'string') {
console.log('--->', handler)            
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

    build: function build$(context) {
        var pipe = this._pipe;
        if (!pipe || context) {
            var handlers = this._handlers.slice();
            handlers.unshift(function pipeHead() {});
            pipe = this._pipe = buildPipe(handlers);
        }

        // remove non-persistent context data if any
        context = Object.keys(context || {}).reduce(function reduce(memo, name) {
            if (name.charAt(0) !== '$') {
                memo[name] = context[name];
            }
            return memo;
        }, {
            validate: {
                request: false // always validate request by default, not now TODO: set to true
            }
        });

        pipe.context = context;
        return pipe;
    }
};

module.exports = Trooba;

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
    console.log('The message has been dropped, ttl expired:', message.type, message.flow);
};

PipePoint.prototype = {
    send: function send$(message) {
        message.context = message.context || this.context;
        if (!message.context.$inited) {
            throw new Error('The context has not been initialized, make sure you use pipe.create()');
        }

        // pick the direction
        var nextPoint;
        if (message.stage === Stages.PROCESS) {
            nextPoint = this; // stay in this point, needs more processing
        }
        else {
            nextPoint = message.flow === Types.REQUEST ? this._next$ : this._prev$;
            message.stage = Stages.TRANSIT;
            // unbound message from this point if any
            if (message.order && this._id === message.pointId) {
                this.queue().done(message);
            }
        }
        // drop message if needed
        message.ttl = message.ttl !== undefined ? message.ttl :
            (Date.now() + (this.context && this.context.ttl || TTL));
        if (message.ttl < Date.now()) {
            // onDrop message and let user know
            (this.context && this.context.onDrop || module.exports.onDrop)(message);
            return;
        }

        if (nextPoint) {
            if (!message.context) {
                throw new Error('Context is missing, make sure context() is used first');
            }
            // forward message down the pipe
            nextPoint.process(message);
        }
        else if (message.type === 'error') {
            throw message.ref;
        }
        else if (message.context && (message.context.$strict &&
            message.context.$strict.indexOf(message.type) !== -1 ||
            message.context.validate && message.context.validate[message.type]
        )) {
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
        ret._pointCtx();
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
        if (this._pointCtx().$linked) {
            throw new Error('The pipe already has a link');
        }
        // allow detection of link action
        this._pointCtx().$linked = true;
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
        });
        pipe.tail.on('$link$', function onEnd(message) {
            if (message.flow === Types.REQUEST) {
                // send forward
                return self.send(message);
            }
        });
    },

    trace: function trace$(callback) {
        var self = this;
        callback = callback || console.log;
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

    resume: function resume() {
        var queue = this.queue();
        queue && queue.resume();
    },

    process: function process$(message) {
        var point = this;

        // get the hooks
        var messageHandlers = this.handlers(message.context);

        // handle linked pipes first
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
            else if (message.flow === Types.RESPONSE) {
                // in response flow it should first go throuh the linked pipe
                if (message.stage === Stages.TRANSIT) {
                    return processMessage(message);
                }
                // make sure it goes to the next point
                message.stage = Stages.TRANSIT;
            }
        }

        if (message.context && message.context.trace && message.context.tracer$) {
            message.context.tracer$(message, point);
        }

        if (message.type === 'trace') {
            message.ref.push({
                point: this,
                flow: message.flow,
                stage: message.stage
            });
        }

        if (point.queue().size(message.context) > 0 &&
                queueAndIfQueued(message)) {
            return;
        }

        var anyType;
        processMessage = messageHandlers[message.type];
        if (!processMessage) {
            processMessage = messageHandlers['*'];
            anyType = true;
        }

        if (processMessage) {
            if (queueAndIfQueued(message)) {
                return;
            }
            // if sync delivery, than no callback needed before propagation further
            processMessage(anyType ? message : message.ref,
                    message.sync ? undefined : onComplete, message.context);
            if (!message.sync) {
                // onComplete would continued the flow
                return;
            }
        }
        else if (processEndEvent()) {
            return;
        }

        sendMessage(message);

        function sendMessage(message) {
            // if link action happend, route to a newly formed route
            if (message.flow === Types.REQUEST && point._pointCtx(message.context).$linked) {
                message.stage = message.stage === Stages.TRANSIT ? Stages.PROCESS : message.stage;
            }
            point.send(message);
        }

        function onComplete(ref) {
            if (arguments.length) {
                message.ref = ref;
            }
            // special case for stream
            if (processEndEvent()) {
                return;
            }

            sendMessage(message);
        }

        function processEndEvent() {
            if ((message.type === 'response:data' ||
                message.type === 'request:data') && message.ref === undefined) {

                var endHandler = messageHandlers[
                    message.flow === Types.REQUEST ? 'request:end' : 'response:end'];
                if (endHandler) {
                    if (queueAndIfQueued(message)) {
                        return true;
                    }
                    endHandler(function onComplete() {
                        point.send(message);
                    });
                    return true;
                }
            }
        }

        function queueAndIfQueued(message) {
            // keep the order for ordered class of messages
            // if point is in process of similar message, the point is paused
            // for the given message till the processing is done
            return message.order && point.queue().add(message);
        }
    },

    /*
    * Create contextual channel
    * context method is a sync method that runs through all handlers
    * to allow them to hook to events they are interested in
    * The context will be attached to every message and bound to pipe
    */
    create: function create$(context, interfaceName) {
        if (typeof arguments[0] === 'string') {
            interfaceName = arguments[0];
            context = undefined;
        }

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
            current = current._next$ ?
                current._next$.copy(context) : undefined;
        }
        context.$inited = true;

        if (!interfaceName) {
            return head;
        }

        var api = head.get(interfaceName);
        if (!api) {
            throw new Error('Cannot find requested API: ' + interfaceName);
        }
        return api(head);
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
        this.resume();

        function sendRequest() {
            var msg = {
                type: 'request',
                flow: Types.REQUEST,
                ref: request
            };
            if (point.context.$requestStream) {
                msg.order = true; // order only streams
            }
            point.send(msg);
        }

        if (callback) {
            point
            .on('error', function (err) { callback(err); })
            .on('response', function (res) {
                point.resume();
                callback(null, res);
            });

            sendRequest();
            return point;
        }

        // this.context.$requestStream ? sendRequest() : setTimeout(sendRequest, 0);
        setTimeout(sendRequest, 0);

        return point;
    },

    respond: function respond$(response) {
        var point = this;
        this.resume();

        function sendResponse() {
            var msg = {
                type: 'response',
                flow: Types.RESPONSE,
                ref: response
            };

            if (point.context.$responseStream) {
                msg.order = true;
            }

            point.send(msg);
        }

        // this.context.$responseStream ? sendResponse() : setTimeout(sendResponse, 0);
        setTimeout(sendResponse, 0);

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

    _pointCtx: function _pointCtx$(ctx) {
        ctx = ctx || this.context;
        if (!ctx) {
            throw new Error('Context is missing, please make sure context() is used first');
        }
        ctx.$points = ctx.$points || {};
        return ctx.$points[this._id] = ctx.$points[this._id] || {
            ref: this
        };
    },

    handlers: function handlers$(ctx) {
        var pointCtx = this._pointCtx(ctx);
        return pointCtx._messageHandlers = pointCtx._messageHandlers || {};
    },

    queue: function queue$() {
        return this._queue = this._queue || new Queue(this);
    }
};

Object.defineProperty(PipePoint.prototype, 'next', {
    get: function getNext() {
        if (this.context && this.context.$points && this._next$) {
            return this.context.$points[this._next$._id].ref;
        }
        return this._next$;
    }
});

Object.defineProperty(PipePoint.prototype, 'prev', {
    get: function getPrev() {
        if (this.context && this.context.$points && this._prev$) {
            return this.context.$points[this._prev$._id].ref;
        }
        return this._prev$;
    }
});

Object.defineProperty(PipePoint.prototype, 'tail', {
    get: function getTail() {
        if (this.context && this._tail$) {
            return this._tail$._pointCtx(this.context).ref;
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
        channel.resume();
        setTimeout(function defer() {
            channel.send({
                type: type,
                flow: ctx.flow,
                ref: data,
                order: true
            });
        }, 0);
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

function Queue(pipe) {
    this.pipe = pipe;
}

module.exports.Queue = Queue;

Queue.prototype = {
    size: function size$(context) {
        return context ? this.getQueue(context).length : 0;
    },

    getQueue: function getQueue(context) {
        if (context) {
            var pointCtx = this.pipe._pointCtx(context);
            return pointCtx.queue = pointCtx.queue || [];
        }
    },

    // return true, if message prcessing should be paused
    add: function add(message) {
        if (!message.order || // no keep order needed
                message.pointId === this.pipe._id) {// or already in process
            message.processed = true;
            return false; // should continue
        }

        var queue = this.getQueue(message.context);
        queue.unshift(message); // FIFO
        message.pointId = this.pipe._id;
        var moreInQueue = queue.length > 1;

        message.processed = !moreInQueue;
        return moreInQueue;
    },

    resume: function resume() {
        var self = this;
        var point = this.pipe;
        setTimeout(function deferResume() {
            var queue = self.getQueue(point.context);
            if (!queue) {
                return;
            }
            var msg = queue[queue.length - 1];
            if (msg) {
                if (msg.processed) {
                    // only resume if it was paused
                    return self.done(msg);
                }
            }
        }, 0);
    },

    done: function done(message) {
        var point = this.pipe;
        var queue = this.getQueue(message.context);
        var msg = queue.pop();
        if (msg !== message) {
            throw new Error('The queue for ' + this.pipe._id + ' is broken');
        }
        // unbound message from this point
        message.pointId = undefined;
        delete message.processed;

        // handle next message
        msg = queue[queue.length - 1];
        if (msg) {
            setTimeout(function () {
                point.process(msg);
            }, 0);
        }
    }
};
