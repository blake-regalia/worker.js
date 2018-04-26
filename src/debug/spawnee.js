const net = require('net');

console.log('spawnee');

// process.on('message', (h_msg) => {
// 	debugger;
// 	console.warn(h_msg);
// });

// process.send('hiii');

// let d_socket = new net.Socket({fd:4});

// d_socket.on('data', (z_in) => {
// 	debugger;
// 	console.info(`worker: [${typeof z_in}] ${z_in}`);

// 	d_socket.write(Buffer.from('got it'));
// });


// process.on('message', (h_msg, d_port) => {
// 	console.log('received: ', h_msg);
// 	// console.log(`${typeof d_port} ${d_port}`);
// 	// d_port.connect(module.paths[0]+'/worker/test');
// 	// d_port.write('test');
// 	let d_socket = net.connect(h_msg.path);
// 	d_socket.write('hello');
// });

let d_socket;

process.on('message', (h_msg, _d_socket) => {
	if('socket' === h_msg.type) {
		console.log(h_msg.name+' received socket');
		d_socket = _d_socket;
		d_socket.on('data', (s_data) => {
			console.log(h_msg.name+' received: '+s_data);
		});
	}
	else if('greet' === h_msg.type) {
		d_socket.write('hello');
	}
});
