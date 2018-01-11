@include '../std.jmacs'

const events = require('./events.js');
const sharing = require('./sharing.js');

class worker extends Worker {

	postPort(d_port, h_msg, a_transfer_paths=[]) {
		// append port to transfer paths
		a_transfer_paths.push(['port']);

		// send
		this.postMessage(Object.assign({
			port: d_port,
		}, h_msg), a_transfer_paths);
	}

	postMessage(h_msg, a_transfer_paths) {
		let a_transfers = [];
		@{each('a_transfer_paths')} {
			let a_path = a_transfer_paths[i_transfer_path];

			let z_walk = h_msg;
			@{each('a_path', 'i_step')} {
				z_walk = z_walk[a_path[i_step]];
			}

			a_transfers.push(...sharing.extract(z_walk));
		}

		try {
			super.postMessage(h_msg, a_transfers);
		}
		catch(e_post) {
			// data clone error
			if('DataCloneError' === e_post.name) {
				console.warn('Did you forget to declare an object that needs to be transferred? Make sure you know when to use worker.manifest()');
				debugger;
			}

			throw e_post;
		}
	}
}

events(worker.prototype);

module.exports = worker;
