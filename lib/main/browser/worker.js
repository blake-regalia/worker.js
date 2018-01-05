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

		super.postMessage(h_msg, a_transfers);
	}
}

events(worker.prototype);

module.exports = worker;
