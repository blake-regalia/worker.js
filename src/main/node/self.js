const net = require('net');

const ipc = require('./ipc.js');

// open socket
let d_socket = new net.Socket({fd:4});

// returns root module
function getRootModule(module){
	return module.parent ? getRootModule(module.parent) : module;
}

// create ipc
module.exports = new ipc(d_socket, {
	origin: getRootModule(module).filename,
	args: process.argv.slice(2),
});
