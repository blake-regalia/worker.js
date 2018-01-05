const fs = require('fs');
const net = require('net');
const os = require('os');

const ipc = require('./ipc.js');

const P_TMP = os.tmpdir()+'/npm-worker';

let h_servers = {};
let c_servers = 0;

module.exports = class channel {
	static kill(si_server) {
		h_servers[si_server].close();
	}

	constructor(s_1, s_2) {
		// socket file name
		let p_socket = P_TMP+'_'+Date.now().toString(16)+'-'+(Math.random()+'').slice(2)+'.sock';

		// server key
		let si_server = (++c_servers)+'';

		// create ipc server
		let d_server = net.createServer((d_socket_1) => {
			// wrap socket in ipc instance
			let k_ipc = this.socket_1 = new ipc(d_socket_1, {
				name: `[${s_1}]<-->${s_2}`,
				path: p_socket,
				server: si_server,
			});

			// if one side terminates connection, close the server
			d_socket_1.on('close', () => {
				console.log('1/2 of socket (1 '+k_ipc.name+') close detected');

				d_server.close();
			});
		});

		// save server
		h_servers[si_server] = d_server;

		// if an error occurred while trying to start the server
		d_server.on('error', (e_server) => {
			throw new Error(e_server);
		});

		// do not close without unlink
		let f_exit = () => d_server.close();
		process.on('exit', f_exit);

		// when the server closes
		d_server.on('close', () => {
			// // try to delete the socket file
			// fs.unlinkSync(p_socket);

			// unbind process listener
			process.removeListener('exit', f_exit);
		});

		// create socket file & bind server to it
		d_server.listen(p_socket);

		// create client socket
		let d_socket_2 = net.connect(p_socket, () => {
			if(this.ready) {
				throw new Error('already called connectListener()');
			}

			this.ready = true;

			if(this.ready_1) {
				this.ready_1(this.socket_1);
				this.ready_1 = null;
			}

			if(this.ready_2) {
				this.ready_2(this.socket_2);
				this.ready_2 = null;
			}
		});

		// wrap socket in ipc instance
		this.socket_2 = new ipc(d_socket_2, {
			name: `${s_1}<-->[${s_2}]`,
			path: p_socket,
			server: si_server,
			suicidal: true,
		});

		// if one side terminates connection, close the server
		d_socket_2.on('close', () => {
			d_server.close();
		});

		Object.assign(this, {
			path: p_socket,
			ready: false,
			ready_1: null,
			ready_2: null,
		});
	}

	port_1(fk_port) {
		if(this.ready) {
			fk_port(this.socket_1);
		}
		else {
			this.ready_1 = fk_port;
		}
	}

	port_2(fk_port) {
		if(this.ready) {
			fk_port(this.socket_2);
		}
		else {
			this.ready_2 = fk_port;
		}
	}
};
