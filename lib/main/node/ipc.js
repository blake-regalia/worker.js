@include '../std.jmacs'

const v8 = require('v8');
const typed_arrays = require('./typed-arrays.js');
const sharing = require('./sharing.js');

const X_WORKER_DEPTH = process.env.WORKER_DEPTH;
const I_WORKER = process.env.WORKER_INDEX;

let i_guid = 1;

module.exports = class ipc {
	constructor(d_socket, h_options={}) {
		let a_aggregate = [];
		let nb_read = 0;
		let nb_content = 0;

		let p_origin = h_options.origin || null;
		let b_suicidal = h_options.suicidal || false;

		// message from other side
		let f_process = (db_msg) => {
			let nb_msg = db_msg.length;

			// supplemental read
			if(nb_read) {
				// increment length
				nb_read += nb_msg;

				// push to aggregate
				a_aggregate.push(db_msg);

				// completely read message
				if(nb_read === nb_content) {
					// concat buffers
					let db_content = Buffer.concat(a_aggregate, nb_content);

					// reset state variables
					a_aggregate.length = 0;
					nb_read = 0;

					// deserialize
					this.deserialize(db_content);
				}
				// went beyond what was expected
				else if(nb_read > nb_content) {
					let n_diff = nb_read - nb_content;

					// correct slice
					a_aggregate[a_aggregate.length-1] = db_msg.slice(0, n_diff);

					// concat buffers
					let db_content = Buffer.concat(a_aggregate, nb_read);

					// reset state variables
					a_aggregate.length = 0;
					nb_read = 0;

					// deserialize first chunk
					this.deserialize(db_content);

					// process rest
					f_process(db_msg.slice(n_diff));
				}
			}
			// first read
			else {
				// length of content
				nb_content = db_msg.readUInt32LE();

				// message ends with this chunk
				if(nb_msg === nb_content + 4) {
					this.deserialize(db_msg.slice(4));
				}
				// multiple messages in this chunk
				else if(nb_content + 4 < nb_msg) {
					// first message
					this.deserialize(db_msg.slice(4, nb_content+4));

					// rest of chunk
					f_process(db_msg.slice(nb_content+4));
				}
				// otherwise keep reading
				else {
					// how many bytes we read this chunk
					nb_read = nb_msg - 4;

					// push chunk to aggregate
					a_aggregate.push(db_msg.slice(4));
				}
			}
		};

		// data processor
		d_socket.on('data', f_process);

		// error handling
		d_socket.on('error', (e_socket) => {
			console.warn('socket error: '+e_socket);
		});

		// socket is being closed
		d_socket.once('close', () => {
			// responsible for closing
			if(b_suicidal) {
				// send message to master to close server
				require('./self.js').postMessage({
					type: 'close_server',
					server: h_options.server,
				});

				// // try to delete the socket file
				// fs.unlinkSync(h_options.path);
			}
		});

		// this instance is worker IPC to master
		if(p_origin && X_WORKER_DEPTH) {
			// transfer from other side
			process.on('message', (h_msg, d_socket_receive) => {
				// make ipc port using socket and info
				let k_ipc = new ipc(d_socket_receive, h_msg.port);

				// this is whole message
				if('data' in h_msg) {
					let h_data = h_msg.data;

					// write port to data object
					h_data.port = k_ipc;

					// handle
					this.message({
						data: h_data,
						origin: null,
					});
				}
				// just the port
				else {
					let s_key = h_msg.port.key;
					let h_msgs = this.port_msgs;

					// message was already received
					if(s_key in h_msgs) {
						let h_msg_received = h_msgs[s_key];

						// write port to data object
						h_msg_received.data.port = k_ipc;

						// trigger message
						this.message(h_msg_received);

						// release message
						delete h_msgs[s_key];
					}
					// message not yet received
					else {
						// save port for when message arrives
						this.ports[s_key] = k_ipc;
					}
				}
			});
		}

		// stream for ipc about task assignments, events and results
		Object.assign(this, {
			name: h_options.name || null,
			origin: p_origin,
			path: h_options.path || null,
			suicidal: b_suicidal,
			server: h_options.server || null,
			args: h_options.args || [],

			socket: d_socket,
			ports: {},
			port_msgs: {},
			streams: {},
			acks: {},
			buffers: {
				message: [],
				error: [],
				messageerror: [],
			},
		});
	}

	deserialize(db_msg) {
		// deserialize message
		let [h_data, a_transfers, p_origin] = v8.deserialize(db_msg);

		// objects were transfered
		if(a_transfers.length) {
			// find shared object refs in data
			sharing.populate(h_data, a_transfers, this);
		}

		// make message
		let h_msg = {
			data: h_data,
			origin: p_origin,
		};

		// port reclaimation
		if(h_data.port) {
			let s_key = h_data.port.key;
			let h_ports = this.ports;

			// port was already received
			if(h_ports[s_key]) {
				// write port to data object
				h_data.port = h_ports[s_key];

				// free to gc
				delete h_ports[s_key];
			}
			// haven't received port yet
			else {
				// save data until we have port
				this.port_msgs[s_key] = h_msg;

				// do not trigger message yet
				return;
			}
		}

		// trigger message
		this.message(h_msg);
	}

	serialize_data_paths(h_data, a_paths) {
		let a_serializations = [];

		// each path
		@{each('a_paths')} {
			let a_path = a_paths[i_path];

			// parent pointer and its key
			let h_parent;
			let s_key;

			// navigation pointer
			let h_nav = h_data;

			// each step in path
			@{each('a_path', 'i_step')} {
				s_key = a_path[i_step];

				// set parent
				h_parent = h_nav;

				// advance pointer
				h_nav = h_nav[s_key];
			}

			// serialize transfer item under pointer
			let [h_datum, a_add] = this.serialize_transfer(h_nav, a_path);

			// replace datum
			h_parent[s_key] = h_datum;

			// push serializations
			a_serializations.push(...a_add);
		}

		 return v8.serialize([h_data, a_serializations]);
	}

	serialize_transfer(z_data, a_path=[], zi_path_last=null) {
		// protect against [object] null
		if(!z_data) return [z_data, []];

		// object
		if('object' === typeof z_data) {
			// output data
			let z_output = z_data;

			// set of transfer objects
			let as_transfers = new Set();

			// copy path
			a_path = a_path.slice();

			// commit to it
			if(null !== zi_path_last) a_path.push(zi_path_last);

			// plain object literal
			if(Object === z_data.constructor) {
				// new object
				z_output = {};

				// scan over enumerable properties
				for(let s_property in z_data) {
					// extract data and transfers by recursing on property
					let [z_datum, a_add] = this.serialize_transfer(z_data[s_property], a_path, s_property);

					// set property on new object
					z_output[s_property] = z_datum;
					
					// add each transferable from recursion to own set
					a_add.forEach(z => as_transfers.add(z));
				}
			}
			// array
			else if(Array.isArray(z_data)) {
				// new array
				z_output = new Array(z_data.length);

				// scan over each item
				z_data.forEach((z_item, i_item) => {
					// extract data and transfers by recursing on item
					let [z_datum, a_add] = this.serialize_transfer(z_item, a_path, i_item);

					// push item to new array
					z_output[i_item] = z_datum;

					// add each transferable from recursion to own set
					a_add.forEach(z => as_transfers.add(z));
				});
			}
			// shareable data
			else if(sharing(z_data)) {
				return [{}, [
					Object.assign(sharing.extract(z_data, this), {
						path: a_path,
					}),
				]];
			}

			// convert set to array
			return [z_output, Array.from(as_transfers)];
		}

		// nothing
		return [z_data, []];
	}

	message(h_msg) {
		this.buffers.message.push(h_msg);
	}

	error(h_msg) {
		this.buffers.error.push(h_msg);
	}


	on(...a_args) {
		// single event
		if(2 === a_args.length) {
			let s_event = a_args[0];

			this[s_event] = a_args[1];

			// empty buffer onto handler in fail-safe manner
			while(this.buffers[s_event].length) {
				f_event(this.buffers[s_event].shift());
			}
		}
		// multiple events
		else if(1 === a_args.length && 'object' === typeof a_args[0]) {
			let h_events = a_args[0];

			for(let s_event in h_events) {
				this.on(s_event, h_events[s_event]);
			}
		}
		// nope
		else {
			throw new Error('misuse of on binding');
		}
	}

	send_port(d_port, h_msg) {
		// transfer handle along with json-serializable message
		process.send(h_msg, d_port);
	}

	export() {
		return {
			key: ++i_guid,
			name: this.name,
			args: this.args,
			origin: this.origin,
			path: this.path,
			server: this.server,
			suicidal: this.suicidal,
		};
	}

	postPort(d_port, h_msg, a_paths) {
		// 'export' port
		let h_port = {};

		// this is an ipc instnace
		if(d_port instanceof ipc) {
			// extract info from ipc
			h_port = d_port.export();

			// extract socket from ipc
			d_port = Object.assign(d_port.socket, {ipc:d_port});
		}
		// at least give it a unique key
		else {
			h_port.key = ++i_guid;
		}

		// long message
		if(a_paths && a_paths.length) {
			// send port over ipc channel
			this.send_port(d_port, {
				port: h_port,
			});

			// send message over pipe
			this.postMessage(Object.assign({
				port: {
					key: h_port.key,
				},
			}, h_msg), a_paths);
		}
		// short message
		else {
			// send port and message over ipc channel
			this.send_port(d_port, {
				data: h_msg,
				port: h_port,
			});
		}
	}

	postMessage(h_data, a_paths=[], b_debug=false) {
		// serialize message
		let db_content = this.serialize_data_paths(h_data, a_paths);

		// prepend length
		let nb_content = db_content.length;
		let db_size = Buffer.allocUnsafe(4);
		db_size.writeUInt32LE(nb_content);

		let db_msg = Buffer.concat([db_size, db_content], 4+nb_content);

		// if(b_debug) {
		// 	console.warn('writing '+db_msg.byteLength+' bytes to socket: '+this.socket);

		// 	let b_clean = this.socket.write(db_msg, (e_write) => {
		// 		console.warn('socket write error: '+e_write);
		// 	});
		// 	console.warn('socket buffer is clean: '+b_clean);
		// }

		// send task to child over ipc
		return this.socket.write(db_msg);
	}

	drain(fk_drain) {
		this.socket.once('drain', fk_drain);
	}

	close() {
		this.socket.end();
		this.socket.unref();
	}
};


