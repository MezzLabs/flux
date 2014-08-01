/*******************************************************************************
 * @license
 * Copyright (c) 2013, 2014 Pivotal Software, Inc. and others.
 * All rights reserved. This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License v1.0
 * (http://www.eclipse.org/legal/epl-v10.html), and the Eclipse Distribution
 * License v1.0 (http://www.eclipse.org/org/documents/edl-v10.html).
 *
 * Contributors:
 *     Pivotal Software, Inc. - initial API and implementation
*******************************************************************************/
/*global require console exports process __dirname*/

// create and configure express
var URI = require('URIjs');
var express = require('express');
var mongo = require('mongodb');
var app = express();
var passport = require('passport');
var pathResolve = require('path').resolve;

var host = process.env.VCAP_APP_HOST || 'localhost';
var port = process.env.VCAP_APP_PORT || '3000';
var homepage = '/client/index.html';
var pathResolve = require('path').resolve;

var isCloudFoundry = host.indexOf('cfapps.io')>=0;

var authentication = require('./authentication');
var ENABLE_AUTH = authentication.isEnabled;
var SUPER_USER = authentication.SUPER_USER;
var passport = authentication.passport;

app.use(express.cookieParser());
app.use(express.bodyParser());
app.use(express.methodOverride());
app.use(authentication.session);

if (ENABLE_AUTH) {
	app.use(passport.initialize());
	app.use(passport.session());
	app.use('/client', authentication.ensureAuthenticated);
}

app.use(app.router);
app.use("/client/js/URIjs", express['static'](__dirname + '/node_modules/URIjs/src'));
app.use("/client", express['static'](__dirname + '/web-editor'));
app.use("/orion-plugin",  express['static'](pathResolve(__dirname, '../flux.orion.integration')));
app.use("/", express['static'](pathResolve(__dirname, 'flux-static')));

function redirectHome(req, res) {
	var target = URI(homepage).query({user: userName(req)}).toString();
	console.log('redirecting: '+target);
	res.redirect(target);
}

if (ENABLE_AUTH) {
	app.get('/auth/github', passport.authenticate('github'));
}

if (ENABLE_AUTH) {
	app.get('/auth/github/callback',
		passport.authenticate('github', { failureRedirect: '/login.html' }),
		redirectHome
	);
}

////////////////////////////////////////////////////////
// Register http end points

function userDisplayName(req) {
	return req && req.user && req.user.displayName;
}

function userName(req) {
	return req && req.user && req.user.username;
}

app.get("/", redirectHome);

app.get("/user",
	function (req, res) {
		var authUser = req.user;
		if (!ENABLE_AUTH) {
			authUser = authentication.defaultUser;
		}
		if (authUser) {
			res.set('Content-Type', 'application/json');
			res.send(JSON.stringify(authUser));
		} else {
			res.status(404);
			res.set('Content-Type', 'application/json');
			res.send(JSON.stringify({error: "Not logged in"}));
		}
	}
);

////////////////////////////////////////////////////////

var server = app.listen(port, host);
console.log('Express server started on port ' + port);

// create and configure socket.io
var io = require('socket.io').listen(server);
//io.set('transports', ['websocket']);
io.set('log level', 1); //socket.io makes too much noise otherwise

if (ENABLE_AUTH) {
	io.set('authorization', authentication.socketIoHandshake);
}

// create and configure services
var MessageCore = require('./messages-core.js').MessageCore;
var messageSync = new MessageCore();

io.sockets.on('connection', function (socket) {
	messageSync.initialize(socket, io.sockets);
});

/////////////////////////////////////////////////////////////////////////

var messagingHost = 'localhost'; //Careful not to use real host name here as that
                                 // won't work on CF deployments.
                                 //The real host name for 'outside' connections
                                 //doesn't expose the port it is actually running on
                                 //but instead remaps that to standard http / https ports.
                                 //so to talk directly to 'ourselves' we use localhost.
var messagingPort = port;

// check for MongoDB and create in-memory-repo in case MongoDB is not available
var MongoClient = mongo.MongoClient;
MongoClient.connect("mongodb://localhost:27017/flight-db", function(err, db) {

	var Repository;
	var repository;

	if (err) {
		console.log('create in-memory backup repository');
		Repository = require('./repository-inmemory.js').Repository;
	}
	else {
		console.log('create mongodb-based backup repository');
		Repository = require('./repository-mongodb.js').Repository;
	}

	repository = new Repository();

	var RestRepository = require('./repository-rest-api.js').RestRepository;
	var restrepository = new RestRepository(app, repository);

	var MessagesRepository = require('./repository-message-api.js').MessagesRepository;
	var messagesrepository = new MessagesRepository(repository);

	var client_io = require('socket.io-client');

	var client_socket = client_io.connect(messagingHost, authentication.asSuperUser({
		port : messagingPort
	}));

	client_socket.on('connect', function() {
		console.log('client socket connected');

		client_socket.emit('connectToChannel', {
			'channel' : SUPER_USER
		}, function(answer) {
			console.log('connectToChannel answer', answer);
			if (answer.connectedToChannel) {
				repository.setNotificationSender.call(repository, client_socket);
				messagesrepository.setSocket.call(messagesrepository, client_socket);
			}
		});
	});

});

require('./start-orion-node')({
	port: 3001,
	fluxPlugin: "http://"+host+":"+port+"/orion-plugin/flux.html"
});
