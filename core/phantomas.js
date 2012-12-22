/**
 * phantomas main file
 */

var VERSION = '0.3';

var phantomas = function(params) {
	// parse script CLI parameters
	this.params = params;

	// --url=http://example.com
	this.url = this.params.url;

	// --format=[csv|json]
	this.resultsFormat = params.format || 'plain';

	// --viewport=1280x1024
	this.viewport = params.viewport || '1280x1024';

	// --verbose
	this.verboseMode = params.verbose === true;
	
	// --silent
	this.silentMode = params.silent === true;

	// --timeout (in seconds)
	this.timeout = (params.timeout > 0 && parseInt(params.timeout, 10)) || 15;

	// --modules=localStorage,cookies
	this.modules = (params.modules) ? params.modules.split(',') : [];

	// setup the stuff
	this.emitter = new (this.require('events').EventEmitter)();
	this.page = require('webpage').create();

	// current HTTP requests counter
	this.currentRequests = 0;

	this.log('phantomas v' + VERSION);

	// load core modules
	this.addCoreModule('requestsMonitor');

	// load 3rd party modules
	var modules = (this.modules.length > 0) ? this.modules : this.listModules(),
		self = this;

	modules.forEach(function(moduleName) {
		self.addModule(moduleName);
	});
};

phantomas.version = VERSION;

phantomas.prototype = {
	metrics: {},
	notices: [],

	// simple version of jQuery.proxy
	proxy: function(fn, scope) {
		scope = scope || this;
		return function () {
			return fn.apply(scope, arguments);
		};
	},

	// emit given event
	emit: function(/* eventName, arg1, arg2, ... */) {
		this.log('Event ' + arguments[0] + ' emitted');
		this.emitter.emit.apply(this.emitter, arguments);
	},

	// bind to a given event
	on: function(ev, fn) {
		this.emitter.on(ev, fn);
	},

	once: function(ev, fn) {
		this.emitter.once(ev, fn);
	},

	// returns "wrapped" version of phantomas object with public methods / fields only
	getPublicWrapper: function() {
		var self = this;

		// modules API
		return {
			url: this.params.url,
			params: this.params,

			// events
			on: function() {self.on.apply(self, arguments);},
			once: function() {self.once.apply(self, arguments);},
			emit: function() {self.emit.apply(self, arguments);},

			// metrics
			setMetric: function() {self.setMetric.apply(self, arguments);},
			setMetricEvaluate: function() {self.setMetricEvaluate.apply(self, arguments);},
			incrMetric: function() {self.incrMetric.apply(self, arguments);},

			// debug
			addNotice: function(msg) {self.addNotice(msg);},
			log: function(msg) {self.log(msg);},
			echo: function(msg) {self.echo(msg);},

			// phantomJS
			evaluate: function(fn) {return self.page.evaluate(fn);},
			injectJs: function(src) {return self.page.injectJs(src);},
			require: function(module) {return self.require(module);},
			getPageContent: function() {return self.page.content;}
		};
	},

	// initialize given core phantomas module
	addCoreModule: function(name) {
		var pkg = require('./modules/' + name + '/' + name);

		// init a module
		pkg.module(this.getPublicWrapper());

		this.log('Core module ' + name + (pkg.version ? ' v' + pkg.version : '') + ' initialized');
	},

	// initialize given phantomas module
	addModule: function(name) {
		var pkg;
		try {
			pkg = require('./../modules/' + name + '/' + name);
		}
		catch (e) {
			this.log('Unable to load module "' + name + '"!');
			return false;
		}

		if (pkg.skip) {
			this.log('Module ' + name + ' skipped!');
			return false;
		}

		// init a module
		pkg.module(this.getPublicWrapper());

		this.log('Module ' + name + (pkg.version ? ' v' + pkg.version : '') + ' initialized');
		return true;
	},

	// returns list of 3rd party modules located in modules directory
	listModules: function() {
		this.log('Getting the list of all modules...');

		var fs = require('fs'),
			modulesDir = fs.workingDirectory + '/modules',
			ls = fs.list(modulesDir) || [],
			modules = [];

		ls.forEach(function(entry) {
			if (fs.isFile(modulesDir + '/' + entry + '/' + entry + '.js')) {
				modules.push(entry);
			}
		});

		return modules;
	},
 
	// runs phantomas
	run: function(callback) {

		// check required params
		if (!this.url) {
			throw '--url argument must be provided!';
		}

		// to be called by tearDown
		this.onDoneCallback = callback;

		this.start = Date.now();

		// setup viewport
		var parsedViewport = this.viewport.split('x');

		if (parsedViewport.length === 2) {
			this.page.viewportSize = {
				height: parseInt(parsedViewport[0], 10) || 1280,
				width: parseInt(parsedViewport[1], 10) || 1024
			};
		}

		// print out debug messages
		this.log('Opening <' + this.url + '>...');
		this.log('Using ' + this.page.settings.userAgent);
		this.log('Viewport set to ' + this.page.viewportSize.height + 'x' + this.page.viewportSize.width);

		// bind basic events
		this.page.onInitialized = this.proxy(this.onInitialized);
		this.page.onLoadStarted = this.proxy(this.onLoadStarted);
		this.page.onLoadFinished = this.proxy(this.onLoadFinished);
		this.page.onResourceRequested = this.proxy(this.onResourceRequested);
		this.page.onResourceReceived = this.proxy(this.onResourceReceived);

		// debug
		this.page.onAlert = this.proxy(this.onAlert);
		this.page.onConsoleMessage = this.proxy(this.onConsoleMessage);

		// observe HTTP requests
		// finish when the last request is completed
		
		// update HTTP requests counter
		this.on('send', this.proxy(function(entry) {
			this.currentRequests++;
		}));
	
		this.on('recv', this.proxy(function(entry) {
			this.currentRequests--;

			this.enqueueReport();
		}));

		// last time changes?
		this.emit('pageBeforeOpen', this.page);

		// open the page
		this.page.open(this.url);

		this.emit('pageOpen');

		// fallback - always timeout after TIMEOUT seconds
		this.log('Run timeout set to ' + this.timeout + ' s');
		setTimeout(this.proxy(function() {
			this.log('Timeout of ' + this.timeout + ' s was reached!');
			this.report();
		}), this.timeout * 1000);
	},

	/**
	 * Wait a second before finishing the monitoring (i.e. report generation)
	 *
	 * This one is called when response is received. Previously scheduled reporting is removed and the new is created.
	 */
	enqueueReport: function() {
		clearTimeout(this.lastRequestTimeout);

		if (this.currentRequests < 1) {
			this.lastRequestTimeout = setTimeout(this.proxy(this.report), 1000);
		}
	},

	// called when all HTTP requests are completed
	report: function() {
		this.emit('report');

		var time = Date.now() - this.start;
		this.log('phantomas work done in ' + time + ' ms');

		// format results
		var results = {
			url: this.url,
			metrics: this.metrics,
			notices: this.notices
		};

		this.emit('results', results);

		// count all metrics
		var metricsCount = 0,
			i;

		for (i in this.metrics) {
			metricsCount++;
		}

		this.log('Formatting results (' + this.resultsFormat + ') with ' + metricsCount+ ' metric(s)...');

		// render results
		var formatter = require('./formatter').formatter,
			renderer = new formatter(results, this.resultsFormat);

		this.echo(renderer.render());

		this.tearDown();
	},

	tearDown: function() {
		this.page.release();

		// call function provided to run() method
		if (typeof this.onDoneCallback === 'function') {
			this.onDoneCallback();
		}
		else {
			phantom.exit(0);
		}
	},

	// core events
	onInitialized: function() {
		// add helper tools into window.phantomas "namespace"
		this.page.injectJs('./core/helper.js');

		this.log('Page object initialized');
		this.emit('init');
	},

	onLoadStarted: function() {
		this.log('Page loading started');
		this.emit('loadStarted');
	},

	onResourceRequested: function(res) {
		this.emit('onResourceRequested', res);
		//this.log(JSON.stringify(res));
	},

	onResourceReceived: function(res) {
		this.emit('onResourceReceived', res);
		//this.log(JSON.stringify(res));
	},

	onLoadFinished: function(status) {
		// trigger this only once
		if (this.onLoadFinishedEmitted) {
			return;
		}
		this.onLoadFinishedEmitted = true;

		// we're done
		this.log('Page loading finished ("' + status + '")');

		switch(status) {
			case 'success':
				this.emit('loadFinished', status);
				break;
		
			default:
				this.emit('loadFailed', status);
				break;
		}

		this.enqueueReport();
	},

	// debug
	onAlert: function(msg) {
		this.log('Alert: ' + msg);
		this.emit('alert', msg);
	},

	onConsoleMessage: function(msg) {
		this.log('console.log: ' + msg);
		this.emit('consoleLog', msg);
	},

	// metrics reporting
	setMetric: function(name, value) {
		this.metrics[name] = (typeof value !== 'undefined') ? value : 0;
	},

	setMetricEvaluate: function(name, fn) {
		this.setMetric(name, this.page.evaluate(fn));
	},

	// increements given metric by given number (default is one)
	incrMetric: function(name, incr /* =1 */) {
		this.metrics[name] = (this.metrics[name] || 0) + (incr || 1);
	},

	// adds a notice that will be emitted after results
	addNotice: function(msg) {
		this.notices.push(msg || '');
	},

	// add log message
	// will be printed out only when --verbose
	log: function(msg) {
		if (this.verboseMode) {
			msg = (typeof msg === 'object') ? JSON.stringify(msg) : msg;

			this.echo('> ' + msg);
		}
	},

	// console.log wrapper obeying --silent mode
	echo: function(msg) {
		if (!this.silentMode) {
			console.log(msg);
		}
	},

	// require CommonJS module from lib/modules
	require: function(module) {
		return require('../lib/modules/' + module);
	}
};

exports.phantomas = phantomas;

