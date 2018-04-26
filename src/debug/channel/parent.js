const net = require('net');
const cp = require('child_process');

let u_proc_1 = cp.fork(__dirname+'/child.js', ['#1']);
let u_proc_2 = cp.fork(__dirname+'/child.js', ['#2']);

// create IPC server
let d_server = net.createServer((d_socket_2) => {
	// send server socket to #2
	u_proc_2.send('socket', d_socket_2);
});

// create socket file
let p_socket = __dirname+'/sibling.sock';

// bind server to socket (this creates a server socket in the above callback)
d_server.listen(p_socket);

// create client socket
let d_socket_1 = net.connect(p_socket, () => {
	// have #1 send to #2
	u_proc_1.send('hey!');

	// have #2 send to #1
	u_proc_2.send('hello');
});

// send client socket to #1
u_proc_1.send('socket', d_socket_1);

