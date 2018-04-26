const net = require('net');
const cp = require('child_process');

// let u_proc = cp.spawn(process.execPath, [__dirname+'/spawnee.js'], {
// 	stdio: ['ignore', 'inherit', 'inherit', 'ipc', 'pipe'],
// });

let u_proc_1 = cp.fork(__dirname+'/spawnee.js');
let u_proc_2 = cp.fork(__dirname+'/spawnee.js');

// let d_socket = u_proc.stdio[4];

// d_socket.on('data', (z_ret) => {
// 	console.warn(`master: [${typeof z_ret}] ${z_ret}`);
// });

// let at_data = Uint8Array.from([42, 41, 60]);
// d_socket.write(Buffer.from(at_data));



// let d_port = net.createConnection(module.paths[0]+'/worker/test');

// u_proc.send({
// 	type: 'port',
// }, d_port);


let d_server = net.createServer((d_socket_1) => {
	// d_socket_1.on('data', (z_msg) => {
	// 	console.log('#1 receieved: '+z_msg);
	// });

	u_proc_1.send({
		type: 'socket',
		name: '#1',
	}, d_socket_1);
});

d_server.on('error', (e_server) => {
	console.error(e_server);
});

let p_socket = __dirname+'/test.sock';
d_server.listen(p_socket);

let d_socket_2 = net.connect(p_socket);

u_proc_2.send({
	type: 'socket',
	name: '#2',
}, d_socket_2);

u_proc_2.send({
	type: 'greet',
	name: '#2',
});

// u_proc.send({
// 	path: p_socket,
// });
